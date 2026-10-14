### Fixed

- **`@reticlehq/server` — `reticle gate` failed after a passing replay.** The gate read only the newest run. A hand drive saves a run with no flow results when its session ends, so a run written after a passing replay hid that replay, and the gate said the flow was not covered. The gate now takes the newest result of each flow from any run.
