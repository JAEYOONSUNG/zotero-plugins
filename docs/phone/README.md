# 논문 — the Zotero library on a phone

A web app you add to the iPhone home screen. No store, no account of its own, no backend of ours.

**https://jaeyoonsung.github.io/zotero-plugins/phone/**

## Setting it up, once

1. Make a Zotero API key at <https://www.zotero.org/settings/keys/new> with **Allow library
   access** and **Allow write access** both ticked.
2. Open the address above in Safari, paste the key, and press 연결.
3. 설정 (the gear at the bottom right) → **키까지 함께 담기**, then 공유 → **홈 화면에 추가**.
   (설정 is groups of rows, as this phone's own settings are: what each thing is on the left, what
   it says on the right, and the explaining in small print under the group.)

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
a finger on one instead opens everything that can be done to it from where you are — 본문 듣기,
PDF 보기, 인용 복사, 공유, and then all three marks, 읽는 중 among them — with the library dimmed
behind it and that one paper left lit. The mark shows in the margin beside the title. The last thing in
that menu is 여러 개 선택: the library turns into a shelf with a circle on each paper, the bar at
the top counts what has been picked and holds the way out, and the bar at the bottom marks or
rates all of them at once — one write per paper, each still against the paper as the server has
it, so nothing is overwritten wholesale. Whatever a mark did, the line that says so carries
되돌리기 for as long as it is up — and a shelf goes back to what each paper was, not all of them
to one thing.
Browse by collection (a collection means everything filed under it) or by tag; what is being
looked at shows as chips that take themselves off. Whichever of the two a paper was last left in the middle of — the
voice or the page — is offered back at the top of the library, with the verb and the screen that
belong to it. A library long enough to be lost in carries landmarks down its
right edge — the letters, the years, the stars — and a finger laid on them takes it there, saying
in full what it is over; the orders whose headings are dates have no one-character name, so they
go without. Search covers the title, authors, journal, year, DOI, tags and the abstract, folds
accents so Muller finds Müller, marks what matched in the row that matched it, and every word has
to appear; the box carries 취소 while it is
open and, when it is open and empty, the last six things that were searched for — each of which
can be tapped back into or forgotten.

**The PDF.** A tap gives the whole screen to the paper — the bar folds away and the page number
stands in for it, as this phone's own reader does, and another tap brings it back. Pinch to zoom,
double tap for 2×, a slider for the long ones, night mode — which follows the phone itself until
you say otherwise, so a paper opened in a dark room does not open as a white rectangle — and out
to any other app through the share sheet — the bar over a paper carries its name, the page and a way
to find a word, and the rest is a menu under one button. A paper opens where it was left. Your own Zotero
highlights are drawn on the page in their own colours, and listed in order with the page each one
is on — and they come out of the paper in one tap, the citation at the top and then every mark
with its page and its own note, ready to paste into what you are writing. Finding a word needs no text layer — the indexed sentences know their pages — so a search
is a list of places to turn to. A paper fetched once opens again with no signal.

**Listening.** The text Zotero indexed, cleaned down to what is worth hearing: the running head,
the download stamp, the page numbers, the author block, the e-mail addresses, the received and
accepted dates, the licence paragraph, the figure captions and the reference list are all left
out; words broken across a line are put back together; citations are dropped from what is said
while the sentence on screen keeps them. The sentence being read is marked, tapping one starts
there, holding one offers to copy it or to turn the PDF to the page it is on, the parts of a paper can be jumped between, a slider shows the place, how big the words
are is the reader's own choice in four steps (it moves the transcript and a paper's own text,
never the chrome), and a sleep timer
stops it after a while or at the end of the part. What has already been heard is set back a shade, so how far
through a paper the voice is can be seen rather than counted, and a reader who scrolled off to
look at something is offered the way back to it. With the PDF open the page turns itself as the
voice moves through — but only while it is playing, so scrolling away leaves you where you are.
The sentence being read is kept in the middle of the screen rather than merely on it, every
sentence, so a glance lands on the same place every time.

The phone's own voices do the speaking, so it costs nothing. Every one of them is offered: the
paper's own language first and whole, then every other language the phone can speak under its own
name, each with the good voices first (Siri, 프리미엄, 고품질) and the toy ones last — and
choosing one says a line in it, because nobody can tell a voice from its name. iOS only downloads
its good voices when somebody asks for them, so the menu ends with where to ask: 설정 → 손쉬운
사용 → 콘텐츠 말하기 → 음성. How loud is a slider of its own; the top of it is the phone's own
volume, which is as loud as any web page is allowed to be. Speeds run to 2×. If iOS drops the
speech, which it does, a watchdog starts the sentence again rather than leaving you looking at one
that never ends.

**Driving.** 운전 모드, the car button on the player. The sentence being read is set the size of a
road sign and held in the middle of the screen, the three buttons that matter become thumb-sized,
everything else gets out of the way, and the whole page is the pause button — nobody aims at a
sentence at seventy. **☰ stays**, because the voice, the volume and 본문만 / 캡션까지 all live
behind it and driving mode is exactly when they are wanted; opened, the settings carry their own
size, big enough to hit at the wheel, and the speed strip comes back with them. The end of a paper is the start of the next one in the library (끝나면 ·
이어서 계속, which 운전 모드 turns on for you), so a drive is not one paper and then silence. The
car's own controls — the wheel, the dashboard, the lock screen — are given the player through
mediaSession, with the paper's name and its authors on the dashboard. The screen is held awake
while a paper is being read: iOS stops a web page's voice when the phone locks, which is the one
thing this app cannot do anything about.

**Taking a paper out.** A heading says how many papers are under it. A paper's own screen hands
it over four ways: the DOI, the link, a line to paste under a slide, and BibTeX — the fields
Zotero actually holds, keyed by author, year and the first word of the title, with the title
braced so a journal's capitals survive.

**Changing things.** Status and rating and notes, in the same places the desktop plugin reads:

| | where it lives |
|---|---|
| status | the tags `/unread`, `/reading`, `/done` |
| rating | the `Rating: N` line in the item's Extra |

A change is kept as an intention, not as fields to send. So a paper changed on the Mac meanwhile
is fetched afresh and "mark it done" applied to that, rather than overwriting someone else's
tags; and a change made with no signal waits in IndexedDB until there is some. The toolbar along
the bottom says how many are waiting, and tapping that tries again. When nothing is happening it
says how old the library is, or 오프라인 — the two things a reader of a library kept on a phone
wants to know.

**On a phone's signal.** A busy server (429, 503) is waited out, doubling the wait and believing
Retry-After when Zotero sends one. A read is tried four times, a change twice, a note once —
because the server may have taken the note even though the answer never arrived.

설정 also shows which build is on the phone and will ask for a newer one — the answer to "is the
new version on here?" should not be "close the app completely and open it again". The build is
the name the service worker keeps the shell under, so the number on screen cannot drift from what
is actually installed.

## The look

It is meant to feel like an app on the phone rather than a page in a browser: a grouped list on a
recessed canvas, hairline separators inset to where the title starts, a large title that shrinks
into the bar as the library is scrolled — taking the search with it, since a tap anywhere on that
bar scrolls back to the top and brings it out again — a toolbar along the bottom rather than a
strip floating over the last row, and screens that come in from the right and are pulled back off
by a finger from the left edge, because iOS keeps its own back gesture for Safari. A menu dims
what is behind it and leaves the row it is about lit and lifted. The chosen thing is a raised
white pill on a soft grey track, never a solid fill and never a coloured bar down the edge of a
row. Pulling the library down turns a ring that fills as it goes and keeps turning until the
library has actually arrived; a first sync of thousands draws how much of it is in along the foot
of the bar; and a list narrowed to nothing offers the button that un-narrows it rather than being
a dead end. In the dark it is a true black canvas with the cards lifted off it — and since a
shadow says nothing on black, everything lifted off the page is lifted by one of two tokens,
which draw a shadow in the light and an edge in the dark. On an iPad or a Mac it keeps a phone's
measure in the middle of the window, with everything pinned to an edge pinned to the edge of that
measure, and where there is a real pointer everything that can be pressed answers it.

Every colour is measured rather than eyeballed: every ink against the paper it is written on, and
every word written on top of a fill rather than beside it — in the dark those four colours are
light tints read as ink on black, so what is written on them turns dark, which is the sort of
thing only a measurement catches. Every class the app asks for is held against what the
stylesheet draws, in both directions; no one class may be given two different sizes in two
different places; and every id the app reaches for is held against the page — a status that was
styled twice over for two different things is exactly what a broken app looks like, and $ on a
renamed id does not throw, it just quietly stops working.

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

A row of the library carries no listeners of its own: both of its gestures are listened for once,
on the list, and the row says which paper it is with `data-key`. A library scrolled to the end of
a few thousand papers would otherwise be holding tens of thousands of listeners.

## A keyboard

For the iPad with one attached, and Safari on a Mac: **space** plays and pauses wherever a paper
is being read, **←** and **→** are the sentence either side, **/** or **f** is the search box,
**esc** closes whatever is on top — a menu, then a field, then the screen — and **return** finishes
picking. Nothing fires while something is being typed into.

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

## English, and Korean

The app is written in Korean, and the Korean sentence is the key: `en.js` turns each one into
English, and anything the table has no answer for still reads as the Korean it was written in
rather than as a blank. A phone set to Korean gets Korean, any other phone gets English, and
설정 · 앱 · 언어 (자동 / 한국어 / English) overrides that. The page's own markup is swapped in place
at start-up, so there is no flash of one language before the other. `test/app.test.mjs` fails when a
Korean string can reach the screen with no English beside it, and fails the other way too, when the
table carries a line the app never says.

## Hearing the translation instead of the paper

The Zotero plugin's reader panel can save a whole-paper translation as a child note. When a paper has
one, the listening settings offer 원문 / 번역: the same player, the same sections, the same page
numbers, with the translated sentences in place of the original ones — and the voice is chosen again
for the language the translation is in, so a Korean translation is read by a Korean voice. Only the
translation is read, never both; the original is in the note so it can be checked, not so a voice can
say every sentence twice.

## The voice the Mac made

Supertonic cannot run on a phone — the model is 383 MB and slower than real time there — so the Mac
reads the paper ahead of time and leaves one m4b in `~/Dropbox/논문 음성` (the plugin's reader panel,
운전용 오디오 만들기). Dropbox is already connected here for the PDFs, so the phone finds that file by
the name the baker gave it, keeps it once fetched, and offers **맥 음성** beside 원문 and 번역.

It is not only a better voice. A real audio file keeps playing with the screen off and answers the
car's buttons, and a web page's own speech does neither — which was the one thing this app could not
do. The sidecar the baker writes beside the file says where every sentence begins, so the list still
follows along and a tap on a sentence still moves the voice to it; without that sidecar the file is
not offered, because a paper you cannot steer is worse than one read by the phone.

## When the phone will not let go of an old copy

The version this phone is running is at the bottom of 설정 · 앱, and **업데이트 확인** asks the
server for a newer one and reloads if there is one. iOS can hold a home-screen app on its own copy
of the shell for days regardless, so **앱 새로 받기** beside it throws the cached files away,
unregisters the service worker and fetches the lot again. It leaves the library alone — that is in
IndexedDB, not in the cache — and it waits for signal, because with none it would leave nothing to
open.

## Still to come

- Audio rendered on the Mac (Supertonic) for lock-screen listening in a nicer voice than the
  phone's own.
- Selecting text on the PDF page itself. Searching it already works, through the indexed text.
