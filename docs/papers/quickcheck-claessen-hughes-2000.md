# QuickCheck Reference

Claessen, K., & Hughes, J. (2000). QuickCheck: A lightweight tool for random
testing of Haskell programs. ICFP 2000.

ScopeWeave uses `fast-check` property tests in the QuickCheck tradition: define
input generators, assert invariants over many generated examples, and preserve
shrunk counterexamples as seed corpus regressions.
