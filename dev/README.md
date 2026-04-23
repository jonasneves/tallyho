# dev/

Ad-hoc internal tooling. Not shipped to the live app, not loaded by `index.html`, not part of the eval harness. Files here exist to make manual workflows less tedious.

## classical-paste.html

Drag-and-drop a photo, runs `analyzeFrame` from `src/classical.js`, prints the result as the four-field `classical_decision` shape (`detected`, `label`, `confidence`, `reasons`) ready to paste into `data/eval/samples.json`.

Open it: `make serve`, then visit `http://localhost:8000/dev/classical-paste.html`. (ES module imports rule out `file://`.)

Workflow: drop the photo, wait for analyze to finish, click **Copy**, paste into the matching sample's `classical_decision` field. Drop a new photo to re-run.
