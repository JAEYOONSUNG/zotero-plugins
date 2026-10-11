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
- Change the **status** and the **rating**, and write a note — all of it in the same places
  the desktop plugin reads, so a change here shows up on the Mac after a sync:
  | | where it lives |
  |---|---|
  | status | the tags `/unread`, `/reading`, `/done` |
  | rating | the `Rating: N` line in the item's Extra |
- Writes carry `If-Unmodified-Since-Version`: an item changed elsewhere since this phone last
  saw it is refused rather than overwritten.

## Still to come

- The PDF itself, from the Dropbox folder the library points at, with read-aloud over the body
  text only (the extraction the desktop plugin already does).
- Audio rendered on the Mac (Supertonic) for lock-screen and offline listening.

## Checking it

```sh
node --test docs/phone/test/app.test.mjs
```

The app is loaded into a fake phone (a DOM, a fake IndexedDB, a fake api.zotero.org) and what
it sends is asserted, so a broken write is caught here and not on the phone.
