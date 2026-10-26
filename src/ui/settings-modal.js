import { getUser, onAuthChange, updateAccount, deleteAccount, changePassword } from '../core/auth.js';
import { loadFeatures } from '../core/features.js';
import { loadCommutes } from '../core/commutes.js';

export function buildSettingsModal(container) {
    container.innerHTML = `
        <div class="settings-backdrop"></div>
        <div class="settings-card">
            <button class="settings-close" aria-label="Close">&times;</button>
            <h2 class="settings-title">Settings</h2>
            <div class="settings-body"></div>
        </div>
    `;

    const body = container.querySelector('.settings-body');

    function close() { container.classList.add('hidden'); }
    function open() {
        render();
        container.classList.remove('hidden');
    }

    container.querySelector('.settings-backdrop').addEventListener('click', close);
    container.querySelector('.settings-close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !container.classList.contains('hidden')) close();
    });

    function render() {
        const user = getUser();
        if (!user) { close(); return; }

        body.innerHTML = '';

        // Display name
        const nameSection = section('Display name');
        const nameRow = document.createElement('div');
        nameRow.className = 'settings-edit-row';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'auth-input';
        nameInput.value = user.displayName;
        nameInput.maxLength = 100;
        const nameSave = document.createElement('button');
        nameSave.className = 'settings-save-btn';
        nameSave.type = 'button';
        nameSave.textContent = 'Save';

        nameSave.addEventListener('click', async () => {
            const val = nameInput.value.trim();
            if (!val || val === user.displayName) return;
            nameSave.disabled = true;
            nameSave.textContent = 'Saving…';
            try {
                await updateAccount(val);
                nameSave.textContent = 'Saved!';
                setTimeout(() => { nameSave.textContent = 'Save'; nameSave.disabled = false; }, 1500);
            } catch (err) {
                nameSave.textContent = err.message || 'Error';
                nameSave.disabled = false;
                setTimeout(() => { nameSave.textContent = 'Save'; }, 2000);
            }
        });

        nameRow.append(nameInput, nameSave);
        nameSection.appendChild(nameRow);
        body.appendChild(nameSection);

        // Email (read-only)
        body.appendChild(infoRow('Email', user.email));

        // Sign-in method
        const methodLabel = user.provider === 'google' ? 'Google' : 'Email';
        body.appendChild(infoRow('Sign-in method', methodLabel));

        // Account tier
        body.appendChild(infoRow('Account tier', user.tier === 'pro' ? 'Pro' : 'Free'));

        // Change password (email users only)
        if (user.provider === 'email') {
            const pwSection = section('Change password');
            const pwCurrent = passwordField('Current password');
            const pwNew = passwordField('New password');
            const pwError = document.createElement('div');
            pwError.className = 'settings-error hidden';
            const pwSubmit = document.createElement('button');
            pwSubmit.className = 'settings-save-btn';
            pwSubmit.type = 'button';
            pwSubmit.textContent = 'Change password';

            pwSubmit.addEventListener('click', async () => {
                const cur = pwCurrent.input.value;
                const nw = pwNew.input.value;
                pwError.classList.add('hidden');
                if (!cur || !nw) {
                    showError(pwError, 'Both fields are required.');
                    return;
                }
                if (nw.length < 8) {
                    showError(pwError, 'New password must be at least 8 characters.');
                    return;
                }
                pwSubmit.disabled = true;
                pwSubmit.textContent = 'Changing…';
                try {
                    await changePassword(cur, nw);
                    loadFeatures();
                    close();
                } catch (err) {
                    showError(pwError, err.message || 'Failed to change password');
                    pwSubmit.disabled = false;
                    pwSubmit.textContent = 'Change password';
                }
            });

            pwSection.append(pwCurrent.field, pwNew.field, pwError, pwSubmit);
            body.appendChild(pwSection);
        }

        // Delete account
        const delSection = section('Delete account');
        const delBtn = document.createElement('button');
        delBtn.className = 'settings-delete-btn';
        delBtn.type = 'button';
        delBtn.textContent = 'Delete account';

        let confirmPending = false;
        const confirmRow = document.createElement('div');
        confirmRow.className = 'settings-delete-confirm hidden';
        confirmRow.innerHTML = '<p>This cannot be undone. Your saved commutes are deleted right away, and your account is permanently removed after 30 days.</p>';
        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'settings-delete-btn settings-delete-confirm-btn';
        confirmBtn.type = 'button';
        confirmBtn.textContent = 'Delete my account';
        confirmRow.appendChild(confirmBtn);

        delBtn.addEventListener('click', () => {
            if (!confirmPending) {
                confirmPending = true;
                confirmRow.classList.remove('hidden');
                delBtn.classList.add('hidden');
            }
        });

        confirmBtn.addEventListener('click', async () => {
            confirmBtn.disabled = true;
            confirmBtn.textContent = 'Deleting…';
            try {
                await deleteAccount();
                loadFeatures();
                loadCommutes();
                close();
            } catch (err) {
                confirmBtn.textContent = err.message || 'Failed';
                confirmBtn.disabled = false;
                setTimeout(() => { confirmBtn.textContent = 'Delete my account'; }, 2000);
            }
        });

        delSection.append(delBtn, confirmRow);
        body.appendChild(delSection);
    }

    function section(label) {
        const el = document.createElement('div');
        el.className = 'settings-section';
        const h = document.createElement('h3');
        h.className = 'settings-section-label';
        h.textContent = label;
        el.appendChild(h);
        return el;
    }

    function infoRow(label, value) {
        const s = section(label);
        const v = document.createElement('div');
        v.className = 'settings-info-value';
        v.textContent = value;
        s.appendChild(v);
        return s;
    }

    function passwordField(placeholder) {
        const field = document.createElement('div');
        field.className = 'settings-pw-field';
        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'auth-input';
        input.placeholder = placeholder;
        field.appendChild(input);
        return { field, input };
    }

    function showError(el, msg) {
        el.textContent = msg;
        el.classList.remove('hidden');
    }

    onAuthChange(() => {
        if (!container.classList.contains('hidden')) render();
    });

    return { open, close };
}
