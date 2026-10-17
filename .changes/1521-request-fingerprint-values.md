### Fixed

- **`@reticlehq/browser` — two different requests with the same keys and the same body length were reported as one write fired twice.** The request fingerprint ignored values, so `{cmd:'accessSets'}` and `{cmd:'currencies'}` to one endpoint got the same identity and raised `duplicate-request`. The fingerprint now hashes the canonical body with a random per-page salt. The salt and the values never leave the page. Closes [#1521](https://github.com/reticlehq/reticle/issues/1521).
