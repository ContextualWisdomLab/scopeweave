const fs = require('fs');

const appJs = fs.readFileSync('app.js', 'utf8');
const findIndexMatchesAppJs = [...appJs.matchAll(/\.findIndex\(/g)];
console.log("app.js findIndex:", findIndexMatchesAppJs.length);

const findMatchesAppJs = [...appJs.matchAll(/\.find\(/g)];
console.log("app.js find:", findMatchesAppJs.length);

const analyticsJs = fs.readFileSync('analytics.js', 'utf8');
const findIndexMatchesAnalyticsJs = [...analyticsJs.matchAll(/\.findIndex\(/g)];
console.log("analytics.js findIndex:", findIndexMatchesAnalyticsJs.length);

const findMatchesAnalyticsJs = [...analyticsJs.matchAll(/\.find\(/g)];
console.log("analytics.js find:", findMatchesAnalyticsJs.length);

const cloudSyncJs = fs.readFileSync('cloud-sync.js', 'utf8');
const findIndexMatchesCloudSyncJs = [...cloudSyncJs.matchAll(/\.findIndex\(/g)];
console.log("cloud-sync.js findIndex:", findIndexMatchesCloudSyncJs.length);

const findMatchesCloudSyncJs = [...cloudSyncJs.matchAll(/\.find\(/g)];
console.log("cloud-sync.js find:", findMatchesCloudSyncJs.length);
