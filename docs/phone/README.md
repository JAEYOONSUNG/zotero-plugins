# 논문 — the Zotero library on a phone

A web app you add to the iPhone home screen. No store, no account of its own, no backend of ours.

**https://jaeyoonsung.github.io/zotero-plugins/phone/**

## Setting it up, once

1. Make a Zotero API key at <https://www.zotero.org/settings/keys/new> with **Allow library
   access** and **Allow write access** both ticked.
2. Open the address above in Safari, paste the key, and press 연결.
3. 설정 (the gear at the bottom right) → **키까지 함께 담기**, then 공유 → **홈 화면에 추가**.

That last step matters: iOS gives a home-screen web app its own storage, separate from Safari's,
so the key has to travel in the address. The icon added that way carries it, and keeps carrying it
if the storage is ever emptied. 설정 also hands the key over as one `number:key` string for
pasting, if the address route ever fails.

The key stays on the phone (localStorage and IndexedDB). Nothing is sent anywhere except to
`api.zotero.org` and, for the PDFs, to Dropbox.

## What it does

**The library.** The whole of it, paged in once and then only what changed (`?since=`,
`/deleted`). Drawn a screenful at a time, so a few thousand papers open at once and scrolling
still reaches the end. The papers are one grouped card with hairline separators, under headings
that say where you are — 오늘, 이번 달, 2024년 11월, the year, the stars, the letter — and the
headings follow whichever of the six orders the list is in (최근 추가, 최근 본, 최근 변경, 연도,
별점, 제목; a menu under the button beside the title). Pushing a paper aside marks it — left is
완료, right is 안 읽음, and a paper already marked that way is cleared, so the same swipe undoes
itself; what the release will do is drawn behind the row while the finger is still on it. Holding
a finger on one instead opens all three marks, 읽는 중 among them, and the mark shows in the
margin beside the title.
Browse by collection (a collection means everything filed under it) or by tag; what is being
looked at shows as chips that take themselves off. Search covers the title, authors, journal,
year, DOI, tags and the abstract, folds accents so Muller finds Müller, and every word has to
appear.

**The PDF.** Pinch to zoom, double tap for 2×, a slider for the long ones, night mode, and out to
any other app through the share sheet — the bar over a paper carries its name, the page and a way
to find a word, and the rest is a menu under one button. A paper opens where it was left. Your own Zotero
highlights are drawn on the page in their own colours, and listed in order with the page each one
is on. Finding a word needs no text layer — the indexed sentences know their pages — so a search
is a list of places to turn to. A paper fetched once opens again with no signal.

**Listening.** The text Zotero indexed, cleaned down to what is worth hearing: the running head,
the download stamp, the page numbers, the author block, the e-mail addresses, the received and
accepted dates, the licence paragraph, the figure captions and the reference list are all left
out; words broken across a line are put back together; citations are dropped from what is said
while the sentence on screen keeps them. The sentence being read is marked, tapping one starts
there, the parts of a paper can be jumped between, a slider shows the place, and a sleep timer
stops it after a while or at the end of the part. With the PDF open the page turns itself as the
voice moves through — but only while it is playing, so scrolling away leaves you where you are.
The phone's own voices do the speaking, so it costs nothing. If iOS drops the speech, which it
does, a watchdog starts the sentence again rather than leaving you looking at one that never ends.

**Changing things.** Status and rating and notes, in the same places the desktop plugin reads:

| | where it lives |
|---|---|
| status | the tags `/unread`, `/reading`, `/done` |
| rating | the `Rating: N` line in the item's Extra |

A change is kept as an intention, not as fields to send. So a paper changed on the Mac meanwhile
is fetched afresh and "mark it done" applied to that, rather than overwriting someone else's
tags; and a change made with no signal waits in IndexedDB until there is some. The toolbar along
the bottom says how many are waiting, and tapping that tries again.

**On a phone's signal.** A busy server (429, 503) is waited out, doubling the wait and believing
Retry-After when Zotero sends one. A read is tried four times, a change twice, a note once —
because the server may have taken the note even though the answer never arrived.

## The look

It is meant to feel like an app on the phone rather than a page in a browser: a grouped list on a
recessed canvas, hairline separators inset to where the title starts, a large title that shrinks
into the bar as the library is scrolled, a toolbar along the bottom rather than a strip floating
over the last row, and screens that come in from the right. The chosen thing is a raised white
pill on a soft grey track, never a solid fill and never a coloured bar down the edge of a row. In
the dark it is a true black canvas with the cards lifted off it. Every class the app asks for is
held against what the stylesheet draws, by a test — a status that was styled twice over for two
different things is exactly what a broken app looks like.

## The PDF, and why Dropbox

Zotero's API hands over an attachment's bytes only for the files Zotero itself stores. This
library keeps almost all of its files as **linked files**: Zotero holds the path, and the file
sits in the Dropbox folder the library points at (`~/Dropbox/0.Personal folder/0. Zotero`). Those
bytes never reach Zotero's servers, so no API key can fetch them — the phone has to ask Dropbox.

It asks with your own Dropbox app, through the PKCE flow, so there is no secret in this page and
no server of ours in between. Once, in Safari:

1. At <https://www.dropbox.com/developers/apps> → **Create app** → Scoped access → **Full Dropbox**.
2. **Permissions** tab: tick `files.metadata.read` and `files.content.read`, Submit.
3. **Settings** tab → **Redirect URIs**: add `https://jaeyoonsung.github.io/zotero-plugins/phone/`.
4. In 논문, the gear → paste the **App key**, check the folder, and press 연결.

The refresh token is kept in this phone's localStorage, like the Zotero key, and travels to the
home-screen app in the same 키까지 함께 담기 link. 설정 shows how much has been downloaded and
empties it. A file Zotero does store is fetched from Zotero instead, with no Dropbox involved; a
file moved inside the folder is found again by its name.

## What is in here

| | |
|---|---|
| `app.js` | the screens, the sync, the writes — the only file that touches the DOM or the network |
| `list.js` | what is shown and in what order: searching, sorting, collections |
| `read.js` | turning Zotero's indexed text into something worth listening to |
| `play.js` | the player: a state machine over the sentences, with the watchdog |
| `pdfview.js` | drawing the pages, the gestures, and the marks over them |
| `files.js` | where a paper's file is, and getting it from Zotero or Dropbox |
| `net.js` | waiting out a busy server, and the queue of changes with no signal |
| `sw.js` | the app shell, fetched fresh when there is signal and from the phone when there is not |
| `vendor/` | pdf.js as Mozilla ships it, unedited |

Everything but `app.js` is a pure module with no DOM and no network, which is why it can all be
checked without a phone.

## Checking it

```sh
node --test docs/phone/test/*.test.mjs
```

The app is loaded into a fake phone — a DOM from linkedom, a fake IndexedDB that honours keyPath,
a fake `api.zotero.org`, a fake Dropbox, a fake voice, a history with a real stack and a clock
each boot can turn by hand — and what it sends is asserted. A write that goes to the wrong place,
a PDF fetched from the wrong service, a running head read aloud or a change lost on a train is
caught here and not on the phone.

Two measurements run against the real library rather than invented papers, using the text Zotero
has already indexed on the Mac:

```sh
node docs/phone/tools/audit.mjs    ~/Zotero/storage 120   # what is still read that should not be
node docs/phone/tools/coverage.mjs ~/Zotero/storage 200   # what is no longer read that should be
```

On 2026-10-13 the first went from 564 sentences read per paper to 401 as the front matter was
dealt with, and the second holds at 75.5% of a file's words read, no paper below a quarter.

## Still to come

- Audio rendered on the Mac (Supertonic) for lock-screen listening in a nicer voice than the
  phone's own.
- Selecting text on the PDF page itself. Searching it already works, through the indexed text.
