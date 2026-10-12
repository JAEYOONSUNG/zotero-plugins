# 논문 — the Zotero library on a phone

A web app you add to the iPhone home screen. No store, no account of its own, no backend.

**https://jaeyoonsung.github.io/zotero-plugins/phone/**

## Setting it up, once

1. Make a Zotero API key at <https://www.zotero.org/settings/keys/new> with **Allow library
   access** and **Allow write access** both ticked.
2. Open the address above in Safari, paste the key, and press 연결.
3. Share → **홈 화면에 추가**, so it opens full screen and works with no signal.

The key and the library stay on the phone (localStorage and IndexedDB). Nothing is sent
anywhere except to `api.zotero.org`.

## What it does

- The whole library, paged in once and then only what changed (`?since=`, `/deleted`).
- Browse by collection, search title, author, journal, year and tags.
- Open a paper for its metadata, abstract, tags, notes and annotations.
- **Listen to the body.** The text Zotero already indexed is cleaned down to what is worth
  hearing — the running head, the download stamp, the page numbers, the figure captions and the
  reference list are left out, words broken across a line are put back together, and the
  citations are dropped from what is said while the sentence on screen keeps them. The sentence
  being read is marked, tapping a sentence starts there, and the place is remembered per paper.
  The phone's own voices do the speaking, so it costs nothing and works with no signal once the
  text has been fetched.
- **Read the PDF itself.** The page is drawn on the phone, turned by scrolling, and zoomed with
  the two buttons in the header. Only the pages near the window are drawn, so a 40-page paper
  opens as quickly as a 4-page one, and a paper fetched once opens again with no signal.
- **Read along.** With the PDF open, the play button reads the body aloud and the page turns
  itself as the voice moves through it; scroll away and it leaves you where you are until you
  press play again. The place in a paper is the same one on both screens.
- Change the **status** and the **rating**, and write a note — all of it in the same places
  the desktop plugin reads, so a change here shows up on the Mac after a sync:
  | | where it lives |
  |---|---|
  | status | the tags `/unread`, `/reading`, `/done` |
  | rating | the `Rating: N` line in the item's Extra |
- Writes carry `If-Unmodified-Since-Version`: an item changed elsewhere since this phone last
  saw it is refused rather than overwritten.

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
4. In 논문, 컬렉션 → 설정, paste the **App key**, check the folder, and press 연결.

The refresh token is kept in this phone's localStorage, like the Zotero key, and travels to the
home-screen app in the same 키까지 함께 담기 link. 설정 shows how much has been downloaded and
empties it.

A file Zotero does store is fetched from Zotero instead, with no Dropbox involved. A file that has
been moved inside the folder is found again by its name.

## Still to come

- Audio rendered on the Mac (Supertonic) for lock-screen listening in a nicer voice than the
  phone's own.
- Selecting and searching text on the PDF page itself (the body is already searchable as text in
  the transcript).

## The icon

`icon-180/192/512.png` is Zotero's own iOS app icon, so 논문 sits on the home screen as the thing
to tap instead of Zotero. It is Zotero's artwork, not this app's drawing. iOS bakes a home-screen
icon in when the app is added and never looks again, so changing it means removing 논문 from the
home screen and adding it back.

## Checking it

```sh
node --test docs/phone/test/*.test.mjs
```

The app is loaded into a fake phone (a DOM, a fake IndexedDB, a fake api.zotero.org, a fake
Dropbox and a fake voice) and what it sends is asserted, so a broken write, a PDF fetched from the
wrong service or a running head read aloud is caught here and not on the phone.
