## 2026-07-12 - O(N) penalty with Array.shift() in queues
**Learning:** In Kahn's topological sort and similar algorithms, using `queue.shift()` inside a while loop causes an O(K) penalty per iteration since the entire remaining array needs to be shifted in memory, turning an O(V+E) algorithm effectively into O(V^2+E) worst case.
**Action:** Always replace `queue.shift()` with a tracking pointer (e.g., `let queueIndex = 0; queue[queueIndex++]`) when using JavaScript arrays as queues in performance-critical graph algorithms.
## 2026-07-12 - Optimize renderTaskRow DOM allocations
**Learning:** Caching unattached template nodes and instantiating them via `.cloneNode(false)` reduces DOM instantiation overhead in O(N) render loops significantly.
**Action:** Apply this optimization to other hot-path rendering elements such as rows, cells, and stack containers.
## 2026-07-13 - Cache static DOM structures in module-level Map templates
**Learning:** In high-frequency rendering loops, repeatedly calling `document.createElement` and configuring attributes node-by-node (like setting `.className`, `.textContent`, `.title`) causes significant JS-to-C++ DOM instantiation overhead. Caching these static/predictable node structures in a `Map` keyed by state (e.g. frozen state objects or discrete strings) and returning `.cloneNode(true)` eliminates redundant overhead.
**Action:** Use a module-level `Map` to cache fully-configured static DOM elements based on their inputs, then return `.cloneNode(true)` during hot path rendering.
## 2026-07-13 - Correctly caching element attributes with cloneNode
**Learning:** Both `Node.cloneNode(false)` and `Node.cloneNode(true)` copy HTML attributes and their values, including reflected properties such as `title`. The `deep` argument controls only whether child nodes are cloned. JavaScript extension properties and listeners registered with `addEventListener()` are not cloned.
**Action:** Select shallow or deep cloning from the required child-node structure, not to preserve reflected attributes. Reapply JavaScript extension properties and event listeners explicitly when cached templates require them.
