# Listen Statistics

A free, local dashboard of your whole listening life, for Spotify: every song
you ever played, joined to your playlists and enriched with genres, countries
and popularity. It is MIT licensed, free forever, needs no account of ours and
runs no server anywhere: everything stays on your computer and the dashboard
only listens on `127.0.0.1`. Package: `@neleus/listen-statistics`.

It includes an MCP server for Spotify. The server controls playback and works
with your library: list your playlists, export them to an enriched CSV, create
playlists and add tracks. It runs locally over stdio, uses OAuth Authorization
Code + PKCE (no client secret), and keeps its token on your own machine. Its
command is available as both `listen-statistics` and `mcp-spotify`, so
existing MCP setups keep working.

Free to use, fork and change under the MIT licence. Built and governed inside
[Neleus](https://neleus.eu); it has no dependency on Neleus and works with any
MCP client (Claude Code, Claude Desktop, and others).

## Your whole listening life in one dashboard

You will see total plays and hours, plays per year, your top artists and songs
all time and per year, forgotten favourites (songs you played a lot and then
not for two years), the songs you skip most, and songs you play a lot that are
in none of your playlists. Below that sits the library view: genres, artist
countries, decades, playlist sizes, popular songs and album ratings.

This guide is written so you can hand it to an agent (Claude Code or any other
MCP client) and let it do the typing. Each step says what you do yourself.

### 1. Ask Spotify for your extended streaming history (you, once)

Open Spotify's privacy settings at <https://www.spotify.com/account/privacy/>,
tick **Extended streaming history** and request it. Spotify emails you a link
to `my_spotify_data.zip`. It can take up to 30 days, so do this first and do
the other steps while you wait. The basic "Account data" export is not enough:
it covers only the last year.

### 2. Create a free Spotify developer app (you, 2 minutes)

1. Go to <https://developer.spotify.com/dashboard> and create an app. Any name
   and description will do.
2. Add the redirect URI `http://127.0.0.1:8888/callback` exactly.
3. Tick "Web API" and save. Copy the **Client ID**. There is no secret to copy.

Spotify requires the app owner to have Premium for development apps.

### 3. Install and authorise (your agent can do this)

```sh
git clone https://github.com/neleus-agent/listen-statistics && cd listen-statistics
npm install && npm run build
SPOTIFY_CLIENT_ID=<your id> node dist/index.js auth          # opens your browser once
SPOTIFY_CLIENT_ID=<your id> node dist/index.js auth status   # should say all scopes granted
```

Optionally register it with your agent so it can also play music and build
playlists for you, for example in Claude Code:

```sh
claude mcp add spotify --env SPOTIFY_CLIENT_ID=<your id> -- node /path/to/dist/index.js
```

### 4. Export your playlists and Liked Songs (a few minutes)

```sh
SPOTIFY_CLIENT_ID=<your id> node dist/index.js export
```

This writes `tracks.csv` and `playlists.csv` to
`~/Downloads/spotify-export-<date>/`. Only playlists you own or collaborate on
can be read; see the platform limits further down.

### 5. Enrich it for free (optional, resumable)

```sh
node dist/index.js enrich ~/Downloads/spotify-export-<date>/tracks.csv --popularity
```

MusicBrainz, ListenBrainz and Deezer need no key. Add Last.fm with a free key
from <https://www.last.fm/api/account/create>:

```sh
LASTFM_API_KEY=<your key> node dist/index.js enrich ~/Downloads/spotify-export-<date>/tracks.csv --lastfm
```

Every answer is cached, so you can stop at any time and run the same command
again to carry on. Honest run times for a library of about 10,000 songs, at
the polite rates these free services ask for: MusicBrainz genres and countries
take roughly 10 to 30 minutes, Deezer and ListenBrainz popularity about half an
hour, Last.fm close to an hour, and `--ratings` about an hour per 4,000
albums. Smaller libraries are proportionally faster; a re-run is nearly free.

### 6. Import your streaming history (seconds)

When the zip arrives, point the importer at it (or at the folder you unzipped
it into):

```sh
node dist/index.js import-history ~/Downloads/my_spotify_data.zip
```

It finds your newest export folder by itself (use `--library <csv>` to pick a
file, `--out <folder>` to write elsewhere) and writes **one** file next to it:
`tracks-history.csv`. Privacy, enforced in code and tests:

- From each stream it keeps only the track URI, timestamp, milliseconds
  played, skipped, and the track, artist and album names. Everything else in
  Spotify's export (network address, device, country, client and so on) is
  dropped in memory and never written.
- Only per-song totals are written: plays (from 30 seconds, as Spotify counts
  them), minutes, skip rate, first and last play date, peak year and plays per
  year. There is no list of individual streams.
- Podcasts and audiobooks are skipped.
- The zip is read in memory and never unpacked to disk. You can delete it
  afterwards.

### 7. Open the dashboard

```sh
npm run dashboard
```

It opens <http://127.0.0.1:8765/> (or the next free port) in your browser and
shows the newest `tracks-history.csv`. Pass a file to show another one:
`npm run dashboard -- path/to/file.csv`. The server answers only on this
computer and only serves the page and that one file. Press Ctrl+C to stop it.

### 8. Things to ask your agent

- "Build me a private playlist of my forgotten favourites from
  tracks-history.csv."
- "Which songs do I play a lot that are in none of my playlists? Put the top
  50 in a new playlist called Hidden Heavy Rotation."
- "What was my top artist each year? Write it as a short story of my
  listening life."
- "Show me the songs I skip most and which of my playlists they are in."
- "Make a playlist of the songs I played most in 2019."
- "Which genres did I discover in the last two years?"

## Tools

| Tool | What it does |
|---|---|
| `play` | Search a track by name and play it (optionally on a named device) |
| `pause_resume`, `skip`, `volume` | Playback control |
| `now_playing` | Current track, device and progress |
| `play_mood` | Play a mood preset (focus, chill, ...) |
| `list_devices`, `transfer` | Spotify Connect devices; move playback |
| `launch_app` | Start the Spotify desktop app |
| `search` | Resolve a song name to `spotify:track:` URIs (does not play) |
| `list_playlists` | Your playlists, with owner, size and whether their tracks are readable |
| `playlist_tracks` | Tracks of one playlist (by name, id, URI or URL) |
| `export_playlists` | Write `tracks.csv` + `playlists.csv` of all readable playlists and Liked Songs |
| `create_playlist` | New playlist, private unless you say otherwise |
| `add_to_playlist` | Add `spotify:track:` URIs to a playlist, in order |

Playback and playlist writes are logged to an append-only JSONL audit
(metadata only, never tokens).

## Setup

1. Create an app at <https://developer.spotify.com/dashboard>. Add the redirect
   URI `http://127.0.0.1:8888/callback` exactly. Copy its Client ID.
2. Build and authorise once:

   ```sh
   npm install && npm run build
   SPOTIFY_CLIENT_ID=<your id> node dist/index.js auth          # opens the browser
   SPOTIFY_CLIENT_ID=<your id> node dist/index.js auth status   # lists any missing scopes
   ```

3. Register it with your MCP client, for example Claude Code:

   ```sh
   claude mcp add spotify --env SPOTIFY_CLIENT_ID=<your id> -- node /path/to/dist/index.js
   ```

The token is stored at `~/.ai/mcp-spotify/spotify.json` (override with
`SPOTIFY_TOKEN_PATH`). See `.env.example` for every setting. New versions that
add scopes need one fresh `auth`; `auth status` tells you.

## Export to CSV

```sh
SPOTIFY_CLIENT_ID=<your id> node dist/index.js export [--out DIR] [--no-liked] [--no-enrich]
```

The default folder is `~/Downloads/spotify-export-<date>/` (or `SPOTIFY_EXPORT_DIR`).
`tracks.csv` has one row per playlist entry: playlist, position, added date,
track, artists, album, album type, release date, year, duration, explicit,
ISRC, genres (from the artists), and tempo, key, time signature, energy,
danceability and valence when Spotify still returns audio features for your
app. `playlists.csv` lists every playlist and whether it was exported or why
it was skipped. Files are UTF-8 with a BOM, so Excel opens accents correctly.

## Enrich with MusicBrainz

```sh
node dist/index.js enrich ~/Downloads/spotify-export-<date>/tracks.csv [--ratings] [--max-ratings N]
```

Needs no Spotify login. It writes `tracks-enriched.csv` next to the input and
adds: original release year (not the remaster year), main genre plus up to five
genres from MusicBrainz's curated genre list, artist country, area and home
town, artist type and active years, and with `--ratings` the album's community
rating out of 5 with its vote count. Songs are matched by ISRC first, then by
exact artist name.

MusicBrainz allows one request per second, so lookups are batched (40 per
request) and every answer is cached in `~/.ai/mcp-spotify/musicbrainz-cache.json`.
A run that stops resumes where it left off; a re-run is nearly free. Ratings
take one request per album, so `--ratings` is the slow part (about an hour per
4,000 albums). Set `MUSICBRAINZ_CONTACT` to a URL or address of yours to
identify your client to MusicBrainz, as they ask. MusicBrainz core data is CC0.

### Song popularity (`--popularity`, `--lastfm`)

```sh
node dist/index.js enrich tracks.csv --popularity            # ListenBrainz + Deezer, no key needed
LASTFM_API_KEY=... LASTFM_USER=you node dist/index.js enrich tracks.csv --lastfm   # adds Last.fm
```

Adds per song: `deezer_rank` (Deezer streaming popularity), `lb_listeners` and
`lb_listens` (ListenBrainz), `lastfm_listeners` and `lastfm_plays` (global
Last.fm), `my_plays` (your own Last.fm scrobbles, fetched fresh every run),
`bpm` where Deezer has it, and `popularity`: a 0-100 percentile **within your
own library**, averaged over the sources that know the song. High is a
well-known track, low a deep cut.

- Last.fm needs a free API key (last.fm/api/account/create). To fill
  `my_plays`, connect Spotify scrobbling in Last.fm under Settings >
  Applications; it counts plays from that day on.
- Each user brings their own Last.fm key. Last.fm's API terms allow
  non-commercial use and ask for attribution. Deezer and ListenBrainz are used
  through their public APIs at a polite rate; answers are cached in
  `~/.ai/mcp-spotify/popularity-cache.json`.

## Library viewer

```sh
node dist/index.js viewer
```

Opens `viewer/index.html`, a single offline page: drop `tracks-enriched.csv`
(or `tracks.csv`) on it to see totals, genres, artist countries, decades, top
artists, playlist sizes, the highest-rated albums and a searchable track list,
filterable per playlist. The file is read in the browser and never uploaded.
Dropping `tracks-history.csv` adds the listening-life views; `npm run dashboard`
serves the same page on `127.0.0.1` and loads the file for you.

## Spotify platform limits (February 2026 development mode)

- The app owner needs an active Spotify **Premium** subscription; a
  development-mode app allows 5 users.
- Tracks are only readable for playlists you **own or collaborate on**.
  Playlists you only follow (Spotify-made or other people's) show up in
  `playlists.csv` as skipped. To export one, open it in Spotify and use
  "Add to other playlist" to copy it into a playlist of your own.
- Audio features (tempo, key) are closed to apps registered after
  27 November 2024; those columns then stay empty. Artist popularity and
  follower counts were removed; genres may be empty for smaller artists.
- Search returns at most 10 results per call.

## Use inside Neleus

Neleus uses this server as one of its connectors. The free Neleus Client
edition ships without it; to add it, build it and register it as an MCP server
like any other client would.

## Development

```sh
npm test        # vitest, no network
npm run lint    # tsc --noEmit
npm run build   # tsup -> dist/
npm run gate    # the public gate (see below)
npm run hooks   # run the gate before every commit and push in your clone
```

## Security and privacy for contributors

Your listening data is personal. It never belongs in this repository, and
three layers make sure it stays out:

- **Never commit exports.** No CSV, TSV or zip files, no Spotify export
  (`my_spotify_data*`, `Streaming_History*`), no caches, no `.env`, no token
  files. `.gitignore` blocks them; test fixtures are invented and built in
  code.
- **The gate.** `npm run gate` fails if any tracked file, or any file anywhere
  in the git history, has one of those names; if a tracked file contains a
  network address (loopback and documentation ranges are fine) or a personal
  streaming-history key; or if a file or any past revision contains a line
  from your own private markers file. That optional file lives outside the
  repository, at `~/.ai/listen-statistics/private-markers.txt` (or the path in
  `LISTEN_STATS_PRIVATE_MARKERS`): put your name, usernames and device or room
  names in it, one per line. `npm run hooks` runs the gate before every commit
  and push.
- **CI.** Every push and pull request runs the build, the tests (including
  the privacy tests) and the gate over the full history.

If the gate finds something in history, deleting the file is not enough: the
history has to be rewritten before anything is published.

## Licence

MIT. See [LICENSE](LICENSE).
