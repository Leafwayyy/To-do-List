// Shared sign-in gate wiring for both the solo app (script.js) and the
// group app (group/group.js). Both pages ship the same auth markup - see
// the .authLoadingScreen/.authOverlay/.userBadge block near the top of
// index.html and group/index.html - so this drives the sign-in flow once
// instead of two copies that can quietly drift apart.
//
// Classic script, loaded by both pages before their own script. Exposes
// window.AuthGate.init({ onSignedIn, onSignedOut }).

(function () {
    const authGoogleBtn = document.querySelector('.authGoogleBtn');
    const authEmailForm = document.querySelector('.authEmailForm');
    const authEmailInput = document.querySelector('.authEmailInput');
    const authPasswordInput = document.querySelector('.authPasswordInput');
    const authPasswordToggleBtn = document.querySelector('.authPasswordToggleBtn');
    const authPasswordStrength = document.querySelector('.authPasswordStrength');
    const authPasswordStrengthFill = document.querySelector('.authPasswordStrengthFill');
    const authPasswordStrengthLabel = document.querySelector('.authPasswordStrengthLabel');
    const authErrorText = document.querySelector('.authErrorText');
    const authInfoText = document.querySelector('.authInfoText');
    const authForgotPasswordBtn = document.querySelector('.authForgotPasswordBtn');
    const authSubmitBtn = document.querySelector('.authSubmitBtn');
    const authModeToggleBtn = document.querySelector('.authModeToggleBtn');
    const authModeLeadText = document.querySelector('.authModeLeadText');
    const authConsentRow = document.querySelector('.authConsentRow');
    const authConsentCheckbox = document.querySelector('.authConsentCheckbox');
    const userBadge = document.querySelector('.userBadge');
    const userBadgeAvatar = document.querySelector('.userBadgeAvatar');
    const userBadgeName = document.querySelector('.userBadgeName');
    const userSignOutBtn = document.querySelector('.userSignOutBtn');

    let authMode = 'signin';

    function setAuthMode(mode) {
        authMode = mode;
        if (authSubmitBtn) {
            authSubmitBtn.textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
        }
        if (authModeLeadText) {
            authModeLeadText.textContent = authMode === 'signup' ? 'Already have an account?' : 'No account yet?';
        }
        if (authModeToggleBtn) {
            authModeToggleBtn.textContent = authMode === 'signup' ? 'Sign in' : 'Sign up';
        }
        if (authConsentRow) {
            authConsentRow.classList.toggle('hidden', authMode !== 'signup');
        }
        if (authPasswordStrength) {
            authPasswordStrength.classList.toggle('hidden', authMode !== 'signup');
            if (authMode === 'signup') {
                updatePasswordStrength();
            }
        }
    }

    // Rough client-side strength estimate - not a security boundary (Firebase
    // still enforces its own minimum server-side), just feedback to nudge
    // people away from "123456" before they hit submit.
    function evaluatePasswordStrength(password) {
        let score = 0;
        if (password.length >= 6) score += 1;
        if (password.length >= 10) score += 1;
        if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
        if (/\d/.test(password)) score += 1;
        if (/[^A-Za-z0-9]/.test(password)) score += 1;

        // Very short passwords stay capped at "weak" no matter how many
        // character classes they mix.
        if (password.length < 6) {
            score = Math.min(score, 1);
        }

        const levels = [
            { label: 'Very weak', level: 1 },
            { label: 'Weak', level: 1 },
            { label: 'Fair', level: 2 },
            { label: 'Good', level: 3 },
            { label: 'Strong', level: 4 }
        ];
        return levels[Math.min(score, levels.length - 1)];
    }

    function updatePasswordStrength() {
        if (!authPasswordStrengthFill || !authPasswordStrengthLabel) {
            return;
        }

        const password = authPasswordInput?.value || '';
        authPasswordStrengthFill.classList.remove('strength-1', 'strength-2', 'strength-3', 'strength-4');

        if (!password) {
            authPasswordStrengthFill.style.width = '0%';
            authPasswordStrengthLabel.textContent = '';
            return;
        }

        const { label, level } = evaluatePasswordStrength(password);
        authPasswordStrengthFill.classList.add(`strength-${level}`);
        authPasswordStrengthFill.style.width = `${(level / 4) * 100}%`;
        authPasswordStrengthLabel.textContent = label;
    }

    function clearAuthError() {
        authErrorText?.classList.add('hidden');
    }

    function clearAuthInfo() {
        authInfoText?.classList.add('hidden');
    }

    function showAuthError(message) {
        clearAuthInfo();
        if (!authErrorText) {
            return;
        }
        authErrorText.textContent = message;
        authErrorText.classList.remove('hidden');
    }

    function showAuthInfo(message) {
        clearAuthError();
        if (!authInfoText) {
            return;
        }
        authInfoText.textContent = message;
        authInfoText.classList.remove('hidden');
    }

    function getAuthErrorMessage(error) {
        const code = error?.code || '';
        if (code.includes('wrong-password') || code.includes('invalid-credential')) {
            return 'Incorrect email or password (or use Continue with Google).';
        }
        if (code.includes('user-not-found')) {
            return 'No account found with that email.';
        }
        if (code.includes('email-already-in-use')) {
            return 'An account already exists with that email.';
        }
        if (code.includes('weak-password')) {
            return 'Password should be at least 6 characters.';
        }
        if (code.includes('invalid-email')) {
            return 'That email address looks invalid.';
        }
        if (code.includes('popup-closed-by-user')) {
            return 'Sign-in was cancelled.';
        }
        return 'Something went wrong. Please try again.';
    }

    function showAuthGate() {
        document.body.classList.add('authGateActive');
        userBadge?.classList.add('hidden');
    }

    function hideAuthGate() {
        document.body.classList.remove('authGateActive');
    }

    function updateAuthUserDisplay(user) {
        if (!userBadge) {
            return;
        }

        userBadge.classList.remove('hidden');
        if (userBadgeName) {
            userBadgeName.textContent = user.displayName || user.email || 'Signed in';
        }
        if (userBadgeAvatar) {
            if (user.photoURL) {
                userBadgeAvatar.src = user.photoURL;
                userBadgeAvatar.classList.remove('hidden');
            } else {
                userBadgeAvatar.classList.add('hidden');
            }
        }
    }

    if (authGoogleBtn) {
        authGoogleBtn.addEventListener('click', async () => {
            clearAuthError();
            try {
                await window.ToDoAuth.signInWithGoogle();
            } catch (error) {
                showAuthError(getAuthErrorMessage(error));
            }
        });
    }

    if (authPasswordToggleBtn && authPasswordInput) {
        authPasswordToggleBtn.addEventListener('click', () => {
            const nowShowing = authPasswordInput.type === 'password';
            authPasswordInput.type = nowShowing ? 'text' : 'password';
            authPasswordToggleBtn.innerHTML = nowShowing
                ? '<i class="fa-solid fa-eye-slash"></i>'
                : '<i class="fa-solid fa-eye"></i>';
            authPasswordToggleBtn.setAttribute('aria-label', nowShowing ? 'Hide password' : 'Show password');
            authPasswordToggleBtn.setAttribute('title', nowShowing ? 'Hide password' : 'Show password');
            authPasswordInput.focus({ preventScroll: true });
        });
    }

    if (authPasswordInput) {
        authPasswordInput.addEventListener('input', updatePasswordStrength);
    }

    if (authModeToggleBtn) {
        authModeToggleBtn.addEventListener('click', () => {
            clearAuthError();
            clearAuthInfo();
            setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
        });
    }

    if (authForgotPasswordBtn) {
        authForgotPasswordBtn.addEventListener('click', async () => {
            clearAuthError();
            clearAuthInfo();

            const email = authEmailInput.value.trim();
            if (!email) {
                showAuthError('Enter your email above first, then click "Forgot password?".');
                return;
            }

            authForgotPasswordBtn.disabled = true;
            try {
                await window.ToDoAuth.sendPasswordReset(email);
                showAuthInfo('Reset email sent. Check your inbox (and spam folder).');
            } catch (error) {
                showAuthError(getAuthErrorMessage(error));
            } finally {
                authForgotPasswordBtn.disabled = false;
            }
        });
    }

    if (authEmailForm) {
        authEmailForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            clearAuthError();

            const email = authEmailInput.value.trim();
            const password = authPasswordInput.value;
            if (!email || !password) {
                showAuthError('Enter an email and password.');
                return;
            }
            if (authMode === 'signup' && authConsentCheckbox && !authConsentCheckbox.checked) {
                showAuthError('Please agree to the Privacy Policy and Terms of Service to create an account.');
                return;
            }

            authSubmitBtn.disabled = true;
            try {
                if (authMode === 'signup') {
                    await window.ToDoAuth.signUpWithEmail(email, password);
                } else {
                    await window.ToDoAuth.signInWithEmail(email, password);
                }
            } catch (error) {
                showAuthError(getAuthErrorMessage(error));
            } finally {
                authSubmitBtn.disabled = false;
            }
        });
    }

    if (userSignOutBtn) {
        userSignOutBtn.addEventListener('click', () => {
            window.ToDoAuth.signOutUser();
        });
    }

    function registerAuthStateHandler(handlers) {
        window.ToDoAuth.onAuthChange((user, isFirstTime) => {
            // Only relevant the very first time this fires - clears the
            // neutral "checking" screen once we actually know whether
            // you're signed in, so we never flash the full sign-in form
            // for someone who is.
            document.body.classList.remove('authChecking');

            if (user) {
                updateAuthUserDisplay(user);
                hideAuthGate();
                handlers.onSignedIn?.(user, isFirstTime);
            } else {
                showAuthGate();
                handlers.onSignedOut?.();
            }
        });
    }

    window.AuthGate = {
        // The Firebase bridge module (firebase-init.js) is a
        // <script type="module">, which always executes after this classic
        // script - so wait for its "ready" signal before touching
        // window.ToDoAuth, rather than assuming it already exists.
        init(handlers) {
            if (window.ToDoAuth) {
                registerAuthStateHandler(handlers);
                return;
            }
            window.addEventListener('todoauth:ready', () => registerAuthStateHandler(handlers), { once: true });
        }
    };
})();
