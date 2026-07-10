## 2026-06-02 - O(N^2) Bottleneck in task rendering
**Learning:** Checking for children tasks with `state.tasks.some` inside a visible tasks render loop (`renderTaskRow`) causes an O(N^2) operation, making the UI very slow for large amounts of rows (e.g. 5000+).
**Action:** Pre-compute a `Set` of parent IDs in `renderAll()` and pass the boolean `hasChildren` down to `renderTaskRow`. This changes the O(N) lookup in every row to an O(1) Set access, reducing rendering bottlenecks significantly while preserving existing behavior.

## 2025-05-31 - O(N²) Performance Bottleneck in getVisibleTasks

**Learning:** `getVisibleTasks()` filters visible items by checking the expansion state of all ancestors for each task using `findTask(parentId)`. Since `findTask` is an O(N) array search and `getVisibleTasks()` runs on every render, this creates an O(N²) bottleneck that freezes the UI on larger project plans.

**Action:** When performing multiple lookups by ID inside loops (especially during render cycles), always construct an O(1) `Map` or dictionary first. Replaced `findTask(parentId)` with a local `taskById` Map lookup to drop the complexity to O(N).
## 2024-05-18 - Prevent O(N^2) bottlenecks when iterating hierarchical arrays
**Learning:** When detecting cycles or traversing parents in a hierarchical array like `tasks`, repeatedly calling `.find()` inside a loop creates an O(N^2) bottleneck, which is devastating for large CSV imports.
**Action:** Always construct an O(1) lookup map (e.g., `new Map(tasks.map(t => [t.id, t]))`) *before* iterating over the array to ensure O(N) complexity for hierarchical validations.
## 2024-05-18 - Avoid array spreading and reversing in rendering loops
**Learning:** Using `[...array].reverse().findIndex(...)` in a tight loop (like rendering Gantt chart bars for every task) is an anti-pattern. It creates a brand new copy of the array and then mutates it on every single iteration, leading to massive memory allocation overhead and garbage collection pauses.
**Action:** Always replace `[...array].reverse().findIndex(...)` with a standard reverse `for` loop starting from `array.length - 1` and iterating backwards, especially inside O(N) rendering functions.
## 2024-05-18 - Prevent O(N^2) bottlenecks when grouping arrays
**Learning:** When grouping elements by a key (e.g., grouping timeline days into weeks), using `Array.find` inside a loop creates an O(N^2) bottleneck, as it scans the accumulated groups on every iteration. This negatively impacts rendering performance.
**Action:** Always use an O(1) `Map` or dictionary to keep track of created groups while accumulating them, reducing the grouping complexity to O(N).

## 2024-05-18 - [Fix O(N) Event Listener Accumulation in Render Cycles]
**Learning:** Attaching event listeners (even with `{ once: true }`) inside frequently executed validation/render functions (like `renderEditorValidation` on every keystroke) leads to severe O(N) accumulation on elements that persist between calls. This triggers duplicate handler executions that synchronously block the main thread.
**Action:** Always attach event listeners once during element creation in the initial render logic (`renderEditorRow`), not inside repeated update/validation cycles.
## 2026-06-21 - Eliminate O(N) Set Allocations in Render Loops
**Learning:** Instantiating new Sets inside a .filter() callback during hot paths (like renderAll which fires on every keystroke) causes massive memory allocations and garbage collection pauses.
**Action:** Move the Set instantiation outside the iteration loop and reuse it via clear() inside the loop to ensure O(1) allocation overhead per render pass.

## 2026-06-22 - calculateDurationDays 연산의 O(N) 캐싱
**Learning:** computeTaskMetrics 함수 내부에서 각 task마다 calculateDurationDays를 두 번씩 호출하고 있었습니다 (totalDays를 구하기 위한 reduce에서 한 번, map 반복문에서 또 한 번). 이는 불필요한 중복 연산을 발생시켰습니다.
**Action:** 첫 번째 순회(reduce) 단계에서 각 task의 기간을 계산한 후 Map에 캐싱하여, 두 번째 순회(forEach) 단계에서 캐싱된 값을 가져오도록 수정함으로써 중복 연산을 완전히 제거했습니다.

## 2026-06-22 - O(N*Depth) cascade deletion UI freeze
**Learning:** Cascading deletions in hierarchical tree structures (like the tasks array) that re-traverse the entire array per depth level using a `while(changed)` condition cause O(N*Depth) operations. In deep or large trees, this causes a severe UI freeze when removing elements.
**Action:** Always pre-compute a parent-to-children mapping using a single O(1) Map, then use BFS with an index cursor to traverse descendant IDs in O(N) operations without queue shifting.

## 2026-06-23 - Remove redundant O(N * Depth) visible tasks filtering loop
**Learning:** `getVisibleTasks()` filters visible items by checking the expansion state of all ancestors for each task. The previous implementation correctly calculated visible tasks using a single O(N) top-down pass, but redundantly executed a secondary `.filter()` loop using a `taskById` map lookup and a tree traversal to root (`while(parentId)`). This unnecessary loop caused a performance bottleneck (taking ~167ms compared to ~13ms for the single-pass logic for 100 iterations of 2000 tasks).
**Action:** When filtering hierarchical data based on parent state, always rely on a single top-down pass that propagates the hidden state (using a Set or property) instead of traversing the tree to the root for every single item in a redundant `.filter()` loop.

## 2026-06-24 - Cache Intl.NumberFormat in render paths
**Learning:** Calling `Number.prototype.toLocaleString()` during table rendering can instantiate locale formatting machinery repeatedly across many rows.
**Action:** Cache a single `Intl.NumberFormat('ko-KR')` formatter inside `formatNumber()` and reuse it for numeric cell rendering.

## 2026-06-25 - Optimize date parsing and prevent cache thrashing
**Learning:** Using `split('-').map(Number)` in a tight date-parsing loop (`dateStringToUtcMs`) allocates new arrays and intermediate strings, causing garbage collection pressure. Additionally, recalculating the same date ranges in loops (like inside `calculatePlannedProgressRatio`) wastes CPU, and small caches (size < 500) cause cache thrashing for larger datasets.
**Action:** Avoid `split().map()` array allocations in hot date parsing paths by reading fixed date segments directly. Reuse already computed durations inside iteration loops instead of recalculating them from dates. Size caches appropriately (e.g. 10000) when expecting a large volume of parsing.

## 2026-06-25 - Fix O(N) array scan during drag-and-drop events
**Learning:** During drag-and-drop, `dragover` events fire continuously at a high frequency. Calling an O(N) operation like `findTask` inside these events creates a severe performance bottleneck, causing UI stutter on large WBS lists.
**Action:** Always map the target array to an O(1) Map inside `dragstart` (e.g. `state.dragTaskCache = new Map(...)`), perform cache lookups inside `dragover` and `drop`, and then set the cache to `null` inside `dragend`.

## 2026-06-29 - Task Lookup Optimization
**Learning:** O(N) array scans (like `findIndex`) inside descendant traversal functions cause CPU bottlenecks on large DOM trees.
**Action:** Replace `findIndex` loops with a lazily-initialized O(1) Map cache mapping task IDs to indices, explicitly invalidating it on array structure changes.

## 2026-06-30 - Redundant O(N) object cloning before JSON serialization
**Learning:** Performing a shallow clone on a large array of objects (e.g. `tasks.map(t => ({...t}))`) just before passing it to `JSON.stringify` creates a massive amount of unnecessary object allocations and causes significant garbage collection overhead, especially in hot paths like autosave. `JSON.stringify` naturally iterates properties without mutating them, making manual cloning redundant unless specific properties need filtering out.
**Action:** Remove redundant array iterations and object spreading when serializing state to JSON. Pass the objects directly.

## 2026-06-27 - Fast path for YYYY-MM-DD date comparisons
**Learning:** Using a validation-backed comparison function (`compareDateStrings` which relies on `isValidDateString` and its constrained cache) inside tight loops, like iterating over all days for every task in `createGanttBarElement` and finding min/max dates, creates redundant validation calls and cache churn.
**Action:** When both date strings are already guaranteed to be valid `YYYY-MM-DD` values, bypass the validation wrapper and use direct lexicographical string comparisons (`a >= b`).

## 2026-06-28 - Replace last-match filter allocation with a backward search
**Learning:** Using `array.filter(condition)` to find the last matching item always performs a full O(N) traversal and allocates an intermediate array. This is wasteful when the caller only needs one element.
**Action:** When only the last matching element is needed, use a reverse `for` loop with an early `break`. The worst-case search remains O(N), but common cases near the end avoid unnecessary scans and allocations.

## 2026-06-29 - Debounce expensive input follow-up work
**Learning:** High-frequency text input can trigger O(N) persistence, metric recomputation, and DOM reconstruction on every keystroke, causing avoidable input jank on large plans.
**Action:** Keep state mutations synchronous, then debounce expensive follow-up work such as full rendering, persistence, and validation display updates. Flush debounced work before blur or submit boundaries where stale UI/state would be confusing.

## 2026-06-29 - Reuse static select option templates
**Learning:** Rebuilding identical `<option>` nodes for every row adds avoidable DOM allocation cost in large tables.
**Action:** Cache static select option templates and clone them per row, then set the selected value on the cloned element.

## 2026-06-29 - Cache active drag-and-drop elements
**Learning:** Cleaning drag/drop classes by querying every table row on each drag event adds avoidable DOM traversal cost.
**Action:** Cache the active drag element and current drop target in state, then clear only those elements during drag cleanup.
## 2026-07-07 - Reduce JS-to-C++ DOM instantiation overhead via template caching
**Learning:** Repeatedly creating DOM nodes or static `{ label, className }` objects in hot rendering paths causes avoidable JS-to-C++ bridge overhead, allocation churn, and GC pressure.
**Action:** Cache static DOM structures as unattached templates with `.cloneNode(true)`, and return shared immutable progress-state constants instead of allocating equivalent objects inside O(N) mapping loops.
