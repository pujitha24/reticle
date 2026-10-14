### Fixed

- **`@reticlehq/server` — `reticle_flow_replay` refused its own `flow` argument.** The schema names `flow` as an alias for `flowName`, but it still required `flowName`. So `{ flow: "checkout" }` failed with "flowName Required" before the replay started. Either name now works.
