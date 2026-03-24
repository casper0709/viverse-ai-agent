# Runtime Gates

Required runtime checks for battletanks-v1:

1. Preview probe evidence exists when runtime verification requested.
2. auth_profile check passes.
3. matchmaking check passes.
4. no critical console signatures.
5. local tank fallback/control baseline preserved:
   - local tank visible when actor resolution lags
   - WASD/Arrow/Space controls captured in iframe context
