🛡️ Sentinel: [HIGH] Fix user enumeration via timing attack in login

🚨 **Severity:** HIGH
💡 **Vulnerability:** `verifyPassword` was conditionally called via short-circuit evaluation in `app.post('/api/auth/login')`. This allowed an attacker to enumerate valid users based on response timing because the scrypt calculation is only executed if the user exists.
🎯 **Impact:** Attackers can determine which email addresses have accounts on the system, which can be leveraged for targeted phishing or brute-force attacks.
🔧 **Fix:** Ensured `verifyPassword` is unconditionally evaluated, passing a dummy password hash (`DUMMY_PASSWORD_HASH`) when the user is not found. Also coerced candidate password to string to avoid potential TypeErrors.
✅ **Verification:** Verify that login requests take consistent time regardless of whether the target user exists or not.

(Also added a journal entry documenting the learning regarding user enumeration.)
