// Brain Dump chat - shared controller. Solo (script.js) and Group
// (group/group.js) both instantiate this same factory, each with its own
// commitTasks callback, since solo and group create tasks completely
// differently under the hood (see script.js's commitAiTasksSolo vs.
// group/group.js's commitAiTasksGroup). Mirrors two conventions already
// established elsewhere in this app: createTourController's "shared
// engine, page-specific callback" factory shape (task-shared.js), and the
// JS-constructed overlay pattern used by initializeTaskEditor()/
// initializeSuggestModal() (built once, appended to document.body,
// visibility toggled via an .open class).
//
// Talks to a small external Cloudflare Worker (see /worker in this repo)
// that holds the Gemini API key server-side and verifies every request
// carries a real Firebase ID token for this project before spending one.
// This file never touches Firestore directly - it only ever gets back a
// list of PROPOSED tasks, shown as editable/uncheckable review cards, and
// hands whatever the user actually confirms to the page's own commitTasks
// callback, which writes them the exact same way manual task entry does.
// Chat history and any attachment are entirely in-memory - nothing here is
// ever persisted, and files are sent to the Worker only for the moment
// they're read, never stored anywhere.

// Fill this in after deploying the Worker - see worker/README.md.
const BRAIN_DUMP_WORKER_URL = 'https://todo-brain-dump.leafwayyy.workers.dev';

const BRAIN_DUMP_MATRIX_OPTIONS = [
    { value: 'do', label: 'Important & Urgent' },
    { value: 'schedule', label: 'Important' },
    { value: 'delegate', label: 'Urgent' },
    { value: 'eliminate', label: 'None' }
];

const BRAIN_DUMP_DIFFICULTY_OPTIONS = [
    { value: 1, label: '1 (Very Easy)' },
    { value: 2, label: '2 (Easy)' },
    { value: 3, label: '3 (Medium)' },
    { value: 4, label: '4 (Hard)' },
    { value: 5, label: '5 (Very Hard)' }
];

const BRAIN_DUMP_ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain';
const BRAIN_DUMP_MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB per attachment, checked client-side
const BRAIN_DUMP_MAX_HISTORY_TURNS = 10;

function brainDumpToDatetimeLocalValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const commaIndex = result.indexOf(',');
            resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// context: 'solo' | 'group' - only ever changes prompt wording server-side,
// never auth or Firestore access. commitTasks(draftTasks): called with the
// user-confirmed, still-checked draft objects (possibly hand-edited) when
// "Add" is clicked - may return a promise. Each draft is
// { text, matrix, taskType, difficulty, estimateMinutes, dueAt, scheduledAt }
// exactly as the AI (or the user's own edit) left it - NOTHING here is
// trusted or sanitized; that's commitTasks' job, same as it would be for
// any other task-creation entry point.
function createBrainDumpController({ context, commitTasks }) {
    let overlay = null;
    let messagesEl = null;
    let attachmentsRowEl = null;
    let textInput = null;
    let sendBtn = null;
    let fileInput = null;

    let history = []; // [{ role: 'user'|'assistant', text }] - capped, never persisted
    let pendingAttachments = []; // [{ mimeType, data, name }] for the NEXT send only
    let isSending = false;

    function isOpen() {
        return Boolean(overlay && overlay.classList.contains('open'));
    }

    function scrollToBottom() {
        if (messagesEl) {
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    function appendUserBubble(text, attachmentNames) {
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgUser');
        const p = document.createElement('p');
        p.textContent = text;
        bubble.appendChild(p);
        if (attachmentNames.length > 0) {
            const names = document.createElement('p');
            names.classList.add('brainDumpMsgAttachments');
            names.textContent = `📎 ${attachmentNames.join(', ')}`;
            bubble.appendChild(names);
        }
        messagesEl.appendChild(bubble);
        scrollToBottom();
    }

    function appendAssistantBubble(replyText) {
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgAssistant');
        const p = document.createElement('p');
        p.textContent = replyText;
        bubble.appendChild(p);
        messagesEl.appendChild(bubble);
        scrollToBottom();
    }

    function appendErrorBubble(text) {
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgError');
        bubble.textContent = text;
        messagesEl.appendChild(bubble);
        scrollToBottom();
    }

    function appendTypingIndicator() {
        const bubble = document.createElement('div');
        bubble.classList.add('brainDumpMsg', 'brainDumpMsgAssistant', 'brainDumpTyping');
        bubble.textContent = 'Thinking...';
        messagesEl.appendChild(bubble);
        scrollToBottom();
        return bubble;
    }

    // Returns { element, read() } rather than stashing state on the DOM
    // node - read() closes over the actual live input elements so it
    // always reflects whatever the user has since edited/unchecked.
    function createTaskReviewCard(draft) {
        const card = document.createElement('div');
        card.classList.add('brainDumpTaskCard');

        const checkboxLabel = document.createElement('label');
        checkboxLabel.classList.add('brainDumpTaskCardCheck');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkboxLabel.appendChild(checkbox);

        const fields = document.createElement('div');
        fields.classList.add('brainDumpTaskCardFields');

        const textInputEl = document.createElement('input');
        textInputEl.type = 'text';
        textInputEl.classList.add('brainDumpTaskCardText');
        textInputEl.value = draft.text || '';
        textInputEl.maxLength = 240;
        fields.appendChild(textInputEl);

        const row = document.createElement('div');
        row.classList.add('brainDumpTaskCardRow');

        const matrixSelectEl = document.createElement('select');
        matrixSelectEl.classList.add('brainDumpTaskCardMatrix');
        BRAIN_DUMP_MATRIX_OPTIONS.forEach((option) => {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            matrixSelectEl.appendChild(opt);
        });
        matrixSelectEl.value = BRAIN_DUMP_MATRIX_OPTIONS.some((o) => o.value === draft.matrix) ? draft.matrix : 'schedule';
        row.appendChild(matrixSelectEl);

        const difficultySelectEl = document.createElement('select');
        difficultySelectEl.classList.add('brainDumpTaskCardDifficulty');
        BRAIN_DUMP_DIFFICULTY_OPTIONS.forEach((option) => {
            const opt = document.createElement('option');
            opt.value = String(option.value);
            opt.textContent = option.label;
            difficultySelectEl.appendChild(opt);
        });
        const parsedDifficulty = Number(draft.difficulty);
        difficultySelectEl.value = (Number.isInteger(parsedDifficulty) && parsedDifficulty >= 1 && parsedDifficulty <= 5)
            ? String(parsedDifficulty)
            : '3';
        row.appendChild(difficultySelectEl);

        const dueAtInputEl = document.createElement('input');
        dueAtInputEl.type = 'datetime-local';
        dueAtInputEl.classList.add('brainDumpTaskCardDeadline');
        if (draft.dueAt && !Number.isNaN(new Date(draft.dueAt).getTime())) {
            dueAtInputEl.value = brainDumpToDatetimeLocalValue(new Date(draft.dueAt));
        }
        row.appendChild(dueAtInputEl);

        fields.appendChild(row);
        card.appendChild(checkboxLabel);
        card.appendChild(fields);

        return {
            element: card,
            read: () => ({
                included: checkbox.checked,
                text: textInputEl.value,
                matrix: matrixSelectEl.value,
                difficulty: difficultySelectEl.value,
                taskType: draft.taskType || 'open',
                estimateMinutes: draft.estimateMinutes || null,
                dueAt: dueAtInputEl.value ? new Date(dueAtInputEl.value).toISOString() : null,
                scheduledAt: draft.scheduledAt || null
            })
        };
    }

    function appendTaskReview(tasks) {
        if (!tasks || tasks.length === 0) {
            return;
        }

        const section = document.createElement('div');
        section.classList.add('brainDumpTaskReview');

        const cards = tasks.map((draft) => {
            const { element, read } = createTaskReviewCard(draft);
            section.appendChild(element);
            return { read };
        });

        const footer = document.createElement('div');
        footer.classList.add('brainDumpTaskReviewFooter');

        const status = document.createElement('p');
        status.classList.add('brainDumpTaskReviewStatus');
        footer.appendChild(status);

        const addBtnLabel = tasks.length === 1 ? 'Add task' : `Add ${tasks.length} tasks`;
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.classList.add('brainDumpAddBtn');
        addBtn.textContent = addBtnLabel;
        addBtn.addEventListener('click', async () => {
            const confirmed = cards.map((card) => card.read()).filter((draft) => draft.included && draft.text.trim());
            if (confirmed.length === 0) {
                status.textContent = 'Nothing checked to add.';
                return;
            }

            addBtn.disabled = true;
            addBtn.textContent = 'Adding...';
            try {
                await commitTasks(confirmed);
                section.innerHTML = '';
                const done = document.createElement('p');
                done.classList.add('brainDumpTaskReviewDone');
                done.textContent = confirmed.length === 1 ? 'Added 1 task.' : `Added ${confirmed.length} tasks.`;
                section.appendChild(done);
                scrollToBottom();
            } catch (error) {
                console.error('Failed to add brain-dump tasks:', error);
                addBtn.disabled = false;
                addBtn.textContent = addBtnLabel;
                status.textContent = 'Could not add those - try again.';
            }
        });
        footer.appendChild(addBtn);

        section.appendChild(footer);
        messagesEl.appendChild(section);
        scrollToBottom();
    }

    function renderAttachmentChips() {
        attachmentsRowEl.innerHTML = '';
        pendingAttachments.forEach((attachment, index) => {
            const chip = document.createElement('span');
            chip.classList.add('brainDumpAttachmentChip');
            chip.textContent = attachment.name;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Remove ${attachment.name}`);
            remove.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            remove.addEventListener('click', () => {
                pendingAttachments.splice(index, 1);
                renderAttachmentChips();
            });
            chip.appendChild(remove);
            attachmentsRowEl.appendChild(chip);
        });
        attachmentsRowEl.classList.toggle('hidden', pendingAttachments.length === 0);
    }

    async function handleFilesSelected(fileList) {
        for (const file of Array.from(fileList)) {
            if (file.size > BRAIN_DUMP_MAX_FILE_BYTES) {
                appendErrorBubble(`"${file.name}" is too large (max 4MB) - skipped.`);
                continue;
            }
            try {
                const data = await readFileAsBase64(file);
                pendingAttachments.push({ mimeType: file.type || 'application/octet-stream', data, name: file.name });
            } catch (error) {
                console.error('Failed to read attachment:', error);
                appendErrorBubble(`Couldn't read "${file.name}" - skipped.`);
            }
        }
        renderAttachmentChips();
    }

    async function sendMessage() {
        const text = textInput.value.trim();
        if (!text && pendingAttachments.length === 0) {
            return;
        }
        if (isSending) {
            return;
        }

        const user = window.ToDoAuth?.auth?.currentUser;
        if (!user) {
            appendErrorBubble('Sign in first.');
            return;
        }

        if (BRAIN_DUMP_WORKER_URL.includes('REPLACE-ME')) {
            appendErrorBubble("Brain Dump isn't set up yet - see worker/README.md.");
            return;
        }

        const attachmentsForThisTurn = pendingAttachments;
        pendingAttachments = [];
        renderAttachmentChips();

        appendUserBubble(text || '(attachment only)', attachmentsForThisTurn.map((a) => a.name));
        textInput.value = '';
        textInput.style.height = 'auto';
        const priorHistory = history.slice(-BRAIN_DUMP_MAX_HISTORY_TURNS);
        history = [...priorHistory, { role: 'user', text }];

        isSending = true;
        sendBtn.disabled = true;
        const typingBubble = appendTypingIndicator();

        try {
            const idToken = await user.getIdToken();
            const response = await fetch(BRAIN_DUMP_WORKER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                body: JSON.stringify({
                    context,
                    message: text,
                    history: priorHistory,
                    attachments: attachmentsForThisTurn.map(({ mimeType, data }) => ({ mimeType, data })),
                    clientTime: new Date().toISOString()
                })
            });

            const data = await response.json().catch(() => null);
            typingBubble.remove();

            if (!response.ok || !data) {
                appendErrorBubble((data && data.reply) || 'Something went wrong - try again in a bit.');
                return;
            }

            appendAssistantBubble(data.reply || "Here's what I found:");
            history = [...history, { role: 'assistant', text: data.reply || '' }].slice(-BRAIN_DUMP_MAX_HISTORY_TURNS);
            appendTaskReview(data.tasks);
        } catch (error) {
            console.error('Brain dump request failed:', error);
            typingBubble.remove();
            appendErrorBubble("Couldn't reach the AI - check your connection and try again.");
        } finally {
            isSending = false;
            sendBtn.disabled = false;
        }
    }

    function build() {
        overlay = document.createElement('div');
        overlay.className = 'brainDumpOverlay';
        overlay.innerHTML = `
            <div class="brainDumpCard" role="dialog" aria-modal="true" aria-label="Brain dump">
                <div class="brainDumpHeader">
                    <h2>Brain Dump</h2>
                    <button type="button" class="brainDumpCloseBtn" aria-label="Close">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
                <p class="brainDumpIntro">Type out whatever's going on - I'll pull out the actual tasks.</p>
                <div class="brainDumpMessages"></div>
                <div class="brainDumpAttachmentsRow hidden"></div>
                <form class="brainDumpComposer">
                    <button type="button" class="brainDumpAttachBtn" aria-label="Attach a photo or file" title="Attach a photo or file">
                        <i class="fa-solid fa-paperclip"></i>
                    </button>
                    <input type="file" class="brainDumpFileInput" accept="${BRAIN_DUMP_ACCEPTED_TYPES}" multiple hidden>
                    <textarea class="brainDumpTextInput" rows="1" placeholder="What's going on? Type it all out..." maxlength="4000"></textarea>
                    <button type="submit" class="brainDumpSendBtn" aria-label="Send">
                        <i class="fa-solid fa-paper-plane"></i>
                    </button>
                </form>
            </div>
        `;
        document.body.appendChild(overlay);

        messagesEl = overlay.querySelector('.brainDumpMessages');
        attachmentsRowEl = overlay.querySelector('.brainDumpAttachmentsRow');
        textInput = overlay.querySelector('.brainDumpTextInput');
        sendBtn = overlay.querySelector('.brainDumpSendBtn');
        fileInput = overlay.querySelector('.brainDumpFileInput');
        const attachBtn = overlay.querySelector('.brainDumpAttachBtn');
        const closeBtn = overlay.querySelector('.brainDumpCloseBtn');
        const composer = overlay.querySelector('.brainDumpComposer');

        composer.addEventListener('submit', (event) => {
            event.preventDefault();
            sendMessage();
        });
        textInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });
        textInput.addEventListener('input', () => {
            textInput.style.height = 'auto';
            textInput.style.height = `${Math.min(textInput.scrollHeight, 160)}px`;
        });

        attachBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                handleFilesSelected(fileInput.files);
            }
            fileInput.value = '';
        });

        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                close();
            }
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && isOpen()) {
                close();
            }
        });
    }

    function open() {
        if (!overlay) {
            build();
        }
        overlay.classList.add('open');
        textInput.focus();
    }

    function close() {
        overlay?.classList.remove('open');
    }

    return { open, close, isOpen };
}
