<!-- Flow 326 fixture (AC10/AC5): invented, for tests only. A reference document
     with two hunk-kind clauses, scored against a diff with >=10 hunks, to pin
     the aggregated report's line bound (one row per clause, not per hunk). -->

# Data Pipeline CLI Fixture (many hunks)

## Hunks

1. A new test asserts on a materialized output, not solely that a mock was invoked. [state:hunk]
2. Every touched module keeps its existing public export names. [state:hunk]

## Change limits

1. A contribution changes no more than 900 lines in total, tests included. [state:pr]
