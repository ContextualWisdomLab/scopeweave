let signupCount = 0;

export function recordSignup() {
  signupCount++;
}

export function getSignupCount() {
  return signupCount;
}
