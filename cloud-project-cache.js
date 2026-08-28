// Keep cloud-opened projects available to the planner's existing local autosave
// contract. The cloud overlay owns project hydration; this adapter makes that
// hydration establish the same browser-local snapshot that bootstrap creates.

const PLANNER_STATE_KEY = 'scopeweave:planner-state:v1';
const CLOUD_PROJECT_KEY = 'scopeweave:project';

/**
 * Persist the already-normalized planner state after a real cloud project is
 * hydrated. Seed/sample hydration has no cloud project id and is never cached
 * by this adapter.
 *
 * @param {{ getState?: () => object }} hostApi Planner host supplied by app.js.
 */
function cacheHydratedCloudProject(hostApi) {
  if (!localStorage.getItem(CLOUD_PROJECT_KEY)) return;
  const snapshot = hostApi?.getState?.();
  if (!snapshot) return;
  try {
    localStorage.setItem(PLANNER_STATE_KEY, JSON.stringify(snapshot));
  } catch {
    // Local persistence can be unavailable (for example, storage policy or
    // quota). The cloud project remains open; later saves surface their own
    // persistence outcome through the planner's existing path.
  }
}

/**
 * Wrap the cloud host once so picker/search/dashboard project opens establish
 * an offline snapshot before subsequent progress, reorder, or expand edits.
 */
function installCloudProjectCacheAdapter() {
  const cloud = window.ScopeWeaveCloud;
  if (!cloud || typeof cloud.init !== 'function' || cloud.__projectCacheAdapterInstalled) return;

  const originalInit = cloud.init.bind(cloud);
  cloud.init = (hostApi) => originalInit({
    ...hostApi,
    hydrateState(savedState) {
      hostApi.hydrateState(savedState);
      cacheHydratedCloudProject(hostApi);
    },
  });
  Object.defineProperty(cloud, '__projectCacheAdapterInstalled', {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

installCloudProjectCacheAdapter();
