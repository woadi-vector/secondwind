# Second Wind

Walking music from the songs someone already loves, set to the pace their steps need.

People with Parkinson's disease often walk better to a steady beat. Physical therapists call this rhythmic auditory cueing: music at or slightly above a person's natural step rate helps lengthen and steady the stride. It works best with music the walker actually likes, and that is where generic workout playlists fail a 75-year-old who grew up on Motown and Patsy Cline.

Second Wind takes a few favorite artists and a walking pace, then builds a playlist that is both personal and safe to step to.

## What the agent does

1. **Finds what they will love.** It asks Qloo's taste graph who else fans of each favorite artist love, using the listener's age. Each favorite is queried on its own and the results are interleaved, so one style cannot drown out another (seeding with the Temptations and Patsy Cline together returns almost only Motown; separately, it returns both).
2. **Gathers real songs.** For each artist it pulls the best-known songs and 30-second previews from Deezer, skipping look-alike uploads (a "Waylon Jennings" with 2 fans instead of the real one with 132,000).
3. **Measures every beat.** It decodes each preview and measures the tempo from the audio itself, then checks that against the catalog's listed tempo. On 232 songs, the listed tempo was missing for about a third and doubled or halved for many others; the measurement catches both.
4. **Refuses songs that would trip someone up.** Ballads in a swaying 12/8 or waltz feel ("Crazy", "These Arms of Mine") can be counted two ways, so steps land unevenly. Those are held out, and the page says why for every one.
5. **Builds the walk.** Songs that fit the pace are ordered from just under the target to just above it, with the listener's named artists first. If a favorite cannot fit, it says so plainly instead of dropping them.

Without Qloo, this is a tempo filter over a generic catalog. With Qloo, it is music this particular person will want to keep walking to.

## Beyond Parkinson's

Second Wind was built and tested for gait training, and that is where its safety rules come from. The engine underneath serves anyone who moves to a set pace. A runner at 170 steps a minute steps twice on every beat of an 85 BPM song; a cyclist at 90 pedal strokes a minute rides a 90 or 180 BPM song. Paces from 60 to 200 work today. Walkers in cardiac or stroke rehabilitation, older adults keeping up a daily walk, runners and cyclists all need the same two things: music they love, and a beat they can trust. For athletes the swing check can relax; for rehabilitation it stays strict.

## Try it

The hosted app runs from a public link with no sign-in. Add artists, tap along with someone's steps (or use the + and − buttons), choose an age range and select **Build the walk**. Every song and every held-out song has a play button.

## Run it yourself

Requires Node 22 or later and a Qloo hackathon API key.

```
git clone https://github.com/woadi-vector/secondwind
cd secondwind
npm ci
cp .env.example .env      # then put your key in .env
node --env-file=.env server.js
```

Open http://localhost:3000.

## How it is built

- `lib/qloo.js`: taste blend across favorites, with duplicate artist merging
- `lib/deezer.js`: artist match with impostor guard, top tracks, previews, catalog tempo
- `lib/audio.js` and `lib/tempo.js`: mp3 decoding and tempo measurement in plain JavaScript
- `lib/select.js`: the rules for what is safe to walk to, and the plain-language reasons
- `lib/pipeline.js`: the whole session, with a tempo cache so each song is measured once
- `server.js` and `public/index.html`: the web app, which streams the agent's progress as it works

Taste data from [Qloo](https://www.qloo.com). Songs, previews and catalog tempos from [Deezer](https://www.deezer.com). Second Wind chooses music; it does not give medical advice. Set walking goals with a physical therapist.

## License

MIT
