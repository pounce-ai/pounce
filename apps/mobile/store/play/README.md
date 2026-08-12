# Play Store listing graphics

The Play listing's icon and feature graphic are uploaded **separately from the
AAB**, so shipping a new app icon inside the binary does not change what the
store page shows. Both files here were regenerated for the purple-cat mark and
need to go up by hand.

| File | Slot | Requirement |
| --- | --- | --- |
| `icon-512.png` | App icon | 512×512, 32-bit PNG |
| `feature-graphic-1024x500.png` | Feature graphic | 1024×500 |

Regenerate with `python3 generate.py` after the master artwork changes. The
feature graphic keeps the composition the listing already used — badge left,
wordmark and tagline right, dark ground — so only the artwork moves.

## Why these are not uploaded by CI

`pounce-play-publisher@peppyhop.iam.gserviceaccount.com` can commit an edit that
changes listing **text**, and can commit a **track release** (it promoted 1.4.0
to production), but an edit containing an **image** asset fails at commit with
`403 The caller does not have permission`. Isolated by committing an empty edit
(OK), a text-only listing edit (OK), then icon and featureGraphic separately
(both fail). Not a format problem — the icon was retried as 32-bit RGBA with the
same result.

So these two files have to be uploaded through the Play Console UI under
**Grow → Store presence → Main store listing**, or the service account needs
whatever store-presence grant covers graphic assets.

Note also that the listing locale is **en-IN**, not `en-US` — querying the API
for `en-US` returns an empty image list rather than an error, which reads as
"nothing is set" when the assets are in fact there.

## App Store

iOS needs nothing equivalent. Since iOS 11 the App Store icon is taken from the
app binary's asset catalog, so it updates when the build goes live. Screenshots
carry forward from the previous version unless replaced.
