/**
 * DeepGalaxy - Offline Flashcard App (Vanilla JS + IndexedDB)
 * Implements strict SM-2 algorithm and user requirements.
 */

// --- Constants & Config ---
const DB_NAME = "DeepGalaxyDB";
const DB_VERSION = 1;

// --- State Management ---
const state = {
    currentView: 'dashboard', // dashboard, deckList, deckEditor, study, stats
    activeDeckId: null,
    studyQueue: [],
    currentCardIndex: 0,
    isShowingAnswer: false
};

// --- Database Layer (IndexedDB Wrapper) ---
const db = {
    instance: null,

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = (event) => reject("DB Error: " + event.target.error);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Decks Store
                if (!db.objectStoreNames.contains('decks')) {
                    const deckStore = db.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
                    deckStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                }

                // Cards Store
                if (!db.objectStoreNames.contains('cards')) {
                    const cardStore = db.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
                    cardStore.createIndex('deckId', 'deckId', { unique: false });
                    cardStore.createIndex('nextReviewAt', 'nextReviewAt', { unique: false });
                    cardStore.createIndex('priorityScore', 'priorityScore', { unique: false });
                }

                // Logs Store
                if (!db.objectStoreNames.contains('logs')) {
                    const logStore = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
                    logStore.createIndex('cardId', 'cardId', { unique: false });
                    logStore.createIndex('reviewedAt', 'reviewedAt', { unique: false });
                    logStore.createIndex('q', 'q', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.instance = event.target.result;
                resolve(this.instance);
            };
        });
    },

    async getAll(storeName) {
        return new Promise((resolve) => {
            const tx = this.instance.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
        });
    },

    async get(storeName, key) {
        return new Promise((resolve) => {
            const tx = this.instance.transaction(storeName, 'readonly');
            const store = tx.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
        });
    },

    async add(storeName, item) {
        return new Promise((resolve) => {
            const tx = this.instance.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.add(item);
            request.onsuccess = () => resolve(request.result);
        });
    },

    async put(storeName, item) {
        return new Promise((resolve) => {
            const tx = this.instance.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.put(item);
            request.onsuccess = () => resolve(request.result);
        });
    },

    async delete(storeName, key) {
        return new Promise((resolve) => {
            const tx = this.instance.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
        });
    },

    async getCardsByDeck(deckId) {
        return new Promise((resolve) => {
            const tx = this.instance.transaction('cards', 'readonly');
            const store = tx.objectStore('cards');
            const index = store.index('deckId');
            const request = index.getAll(IDBKeyRange.only(Number(deckId)));
            request.onsuccess = () => resolve(request.result);
        });
    }
};

// --- Algorithm & Logic Core ---

const Logic = {
    // Math Utilities
    now() { return new Date(); },

    // Calculate SM-2 updates
    calculateSM2(card, q) {
        let { n, I, EF } = card;
        let nextN, nextI, nextEF;

        if (q < 3) {
            nextN = 0;
            nextI = 1; // 1 day
        } else {
            nextN = n + 1;
            if (nextN === 1) {
                nextI = 1;
            } else if (nextN === 2) {
                nextI = 6;
            } else {
                nextI = Math.round(I * EF);
            }
        }

        let delta = (5 - q);
        let efChange = (0.1 - delta * (0.08 + delta * 0.02));
        nextEF = EF + efChange;
        if (nextEF < 1.3) nextEF = 1.3;

        return { n: nextN, I: nextI, EF: nextEF };
    },

    // Extended Statistics Logic for priority
    // User global forget rate (last 30 days)
    async getUserStats() {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        const isoDate = thirtyDaysAgo.toISOString();

        return new Promise((resolve) => {
            const tx = db.instance.transaction('logs', 'readonly');
            const store = tx.objectStore('logs');
            const index = store.index('reviewedAt');
            const range = IDBKeyRange.lowerBound(isoDate);
            const request = index.getAll(range);

            request.onsuccess = () => {
                const result = request.result;
                if (!result || result.length === 0) {
                    resolve({ forgetRate: 0, total: 0 });
                    return;
                }

                const failed = result.filter(l => l.q < 3).length;
                const forgetRate = failed / result.length;
                resolve({ forgetRate, total: result.length });
            };

            request.onerror = () => resolve({ forgetRate: 0, total: 0 });
        });
    },

    // Calculate Card Parameters (Retention, Priority, etc.)
    calculateCardStats(card, userForgetRate) {
        if (card.n === 0) {
            return {
                retention: 0,
                forgetRisk: 1.0,
                priorityScore: 100 // High priority for new cards
            };
        }

        const now = new Date();
        const lastReview = card.lastReviewAt ? new Date(card.lastReviewAt) : new Date();
        const t_days = (now - lastReview) / (1000 * 60 * 60 * 24);

        const S = card.I * card.EF;
        const safeS = S > 0 ? S : 0.1;

        const retentionProbability = Math.exp(-t_days / safeS); // R(t)
        const forgetRisk = 1 - retentionProbability; // Forecast forget rate

        const successes = card.totalSuccesses || card.n;
        const retentionScore = Math.min(100, Math.log2(1 + successes) * card.EF * 10);

        let overdueDays = 0;
        if (card.nextReviewAt) {
            const dueDate = new Date(card.nextReviewAt);
            if (now > dueDate) {
                overdueDays = (now - dueDate) / (1000 * 60 * 60 * 24);
            }
        }

        const easePenalty = 1.0 / card.EF;

        const priorityScore =
            (forgetRisk * 0.5) +
            ((1 - retentionScore / 100) * 0.3) +
            (easePenalty * 0.1) +
            (Math.log10(1 + overdueDays) * 0.1);

        return {
            retentionProbability,
            forgetRisk,
            retentionScore,
            priorityScore
        };
    },

    async getDueCards() {
        const allCards = await db.getAll('cards');
        const now = new Date();
        const { forgetRate } = await this.getUserStats();

        const cardsWithPriority = allCards.map(card => {
            const stats = this.calculateCardStats(card, forgetRate);
            return { ...card, ...stats };
        });

        const due = cardsWithPriority.filter(c => {
            if (!c.nextReviewAt) return true; // New cards
            const dueDate = new Date(c.nextReviewAt);
            return dueDate <= now || c.priorityScore >= 0.6;
        });

        // Sort by priorityScore desc
        due.sort((a, b) => b.priorityScore - a.priorityScore);

        return due;
    }
};

// --- UI Components / Renderer ---

const UI = {
    app: document.getElementById('app'),

    render(template) {
        this.app.innerHTML = template;
        lucide.createIcons();
    },

    // 1. Dashboard
    async renderDashboard() {
        const stats = await Logic.getUserStats();
        const logs = await db.getAll('logs');
        const cards = await db.getAll('cards');
        const dueCards = await Logic.getDueCards();

        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const logs7d = logs.filter(l => new Date(l.reviewedAt) > sevenDaysAgo);
        const success7d = logs7d.filter(l => l.q >= 3).length;
        const rate7d = logs7d.length ? Math.round((success7d / logs7d.length) * 100) : 0;

        const badCards = cards.filter(c => c.EF < 1.5).length;

        const html = `
            <div class="container animate-fade-in">
                <header class="flex justify-between items-center" style="margin-bottom: 2rem;">
                    <h1>DeepGalaxy</h1>
                    <div class="flex gap-2">
                        <button class="btn btn-secondary" onclick="App.navigateTo('settings')">
                            <i data-lucide="settings"></i> データ管理
                        </button>
                        <button class="btn btn-primary" onclick="App.navigateTo('deckList')">
                            <i data-lucide="layers"></i> 単語帳管理
                        </button>
                    </div>
                </header>

                <div class="stats-grid">
                    <div class="stat-card">
                        <h3>今日の復習</h3>
                        <div class="stat-value">${dueCards.length}</div>
                    </div>
                    <div class="stat-card">
                        <h3>定着率 (7日)</h3>
                        <div class="stat-value">${rate7d}%</div>
                        <small>忘却率: ${(stats.forgetRate * 100).toFixed(1)}%</small>
                    </div>
                     <div class="stat-card">
                        <h3>苦手カード</h3>
                        <div class="stat-value" style="color: var(--warning-color); -webkit-text-fill-color: initial;">${badCards}</div>
                    </div>
                </div>

                <div class="card" style="text-align: center; padding: 4rem 2rem;">
                    <h2>学習を始めましょう</h2>
                    <p style="color: var(--text-secondary); margin: 1rem 0 2rem;">今日優先すべきカードは ${dueCards.length} 枚です。</p>
                    <button class="btn btn-primary" style="font-size: 1.25rem; padding: 1rem 3rem;" onclick="App.startSession()">
                        <i data-lucide="play"></i> 学習開始
                    </button>
                </div>
            </div>
        `;
        this.render(html);
    },

    // 2. Deck List
    async renderDeckList() {
        const decks = await db.getAll('decks');

        let decksHtml = decks.map(deck => `
            <div class="card flex justify-between items-center">
                <div>
                    <h3>${deck.name}</h3>
                    <p style="color: var(--text-secondary)">作成日: ${new Date(deck.createdAt).toLocaleDateString()}</p>
                </div>
                <div class="flex gap-2">
                    <button class="btn btn-secondary" onclick="App.editDeck(${deck.id})">
                        <i data-lucide="edit"></i> 編集
                    </button>
                    <button class="btn btn-secondary" onclick="App.manageCards(${deck.id})">
                        <i data-lucide="list"></i> カード一覧
                    </button>
                     <button class="btn btn-danger" onclick="App.deleteDeck(${deck.id})">
                        <i data-lucide="trash"></i>
                    </button>
                </div>
            </div>
        `).join('');

        const html = `
            <div class="container animate-fade-in">
                <header class="flex justify-between items-center" style="margin-bottom: 2rem;">
                    <button class="btn btn-secondary" onclick="App.navigateTo('dashboard')">
                        <i data-lucide="arrow-left"></i> 戻る
                    </button>
                    <h1>単語帳一覧</h1>
                    <button class="btn btn-primary" onclick="App.createDeck()">
                        <i data-lucide="plus"></i> 新規作成
                    </button>
                </header>
                <div class="flex flex-col gap-4">
                    ${decksHtml || '<p style="text-align:center; color:var(--text-secondary)">単語帳がありません。「新規作成」から追加してください。</p>'}
                </div>
            </div>
        `;
        this.render(html);
    },

    // 3. Card Manager
    async renderCardManager(deckId) {
        const deck = await db.get('decks', deckId);
        const cards = await db.getCardsByDeck(deckId);

        let cardsHtml = cards.map(c => `
             <div class="card">
                <div class="flex justify-between">
                    <div style="flex: 1">
                        <strong>表:</strong> ${c.frontText || '(画像)'} <br>
                        <small style="color: var(--text-secondary)">EF: ${c.EF.toFixed(2)} | 次回: ${c.nextReviewAt ? new Date(c.nextReviewAt).toLocaleDateString() : '未学習'}</small>
                    </div>
                    <div class="flex gap-2">
                         <button class="btn btn-secondary" onclick="App.editCard(${c.id}, ${deckId})">
                            <i data-lucide="edit"></i>
                        </button>
                        <button class="btn btn-danger" onclick="App.deleteCard(${c.id}, ${deckId})">
                            <i data-lucide="trash"></i>
                        </button>
                    </div>
                </div>
            </div>
        `).join('');

        const html = `
             <div class="container animate-fade-in">
                <header class="flex justify-between items-center" style="margin-bottom: 2rem;">
                     <button class="btn btn-secondary" onclick="App.navigateTo('deckList')">
                        <i data-lucide="arrow-left"></i> 戻る
                    </button>
                    <h1>${deck.name} - カード一覧</h1>
                    <button class="btn btn-primary" onclick="App.createCard(${deckId})">
                        <i data-lucide="plus"></i> カード追加
                    </button>
                </header>
                 <div class="flex flex-col gap-4">
                    ${cardsHtml || '<p style="text-align:center; color:var(--text-secondary)">カードがありません。</p>'}
                </div>
            </div>
        `;
        this.render(html);
    },

    // 4. Study Mode
    renderStudyCard(card, total, current) {
        const frontContent = `
            ${card.frontImage ? `<img src="${card.frontImage}" alt="Front">` : ''}
            ${card.frontText ? `<p>${card.frontText}</p>` : ''}
        `;

        const backContent = `
             ${card.backImage ? `<img src="${card.backImage}" alt="Back">` : ''}
            ${card.backText ? `<p>${card.backText}</p>` : ''}
        `;

        const html = `
            <div class="container animate-fade-in" style="height: 100vh; display: flex; flex-direction: column;">
                <div class="flex justify-between items-center">
                    <button class="btn btn-secondary" onclick="App.navigateTo('dashboard')">終了</button>
                    <span>カード ${current + 1} / ${total}</span>
                    <span>スコア: ${Math.round(card.priorityScore * 100) || 0}</span>
                </div>

                <div class="study-container" style="flex: 1; display: flex; flex-direction: column; justify-content: center;">
                    <div class="flashcard" onclick="App.flipCard()">
                        <div class="flashcard-content">
                            <div style="color: var(--text-secondary); font-size: 0.9rem; text-transform: uppercase; margin-bottom: 1rem;">表（問題）</div>
                            ${frontContent}
                            ${state.isShowingAnswer ? `
                                <hr style="border: 0; border-top: 1px solid var(--border-color); margin: 2rem 0;">
                                <div style="color: var(--text-secondary); font-size: 0.9rem; text-transform: uppercase; margin-bottom: 1rem;">裏（解答）</div>
                                <div class="animate-fade-in">${backContent}</div>
                            ` : '<p style="margin-top:2rem; color:var(--text-secondary); font-size:0.9rem;">(タップして解答を表示)</p>'}
                        </div>
                    </div>

                    ${state.isShowingAnswer ? `
                        <div class="action-bar animate-fade-in">
                            <button class="grade-btn grade-1" onclick="App.submitReview(1)">
                                全く覚えていない<br><small>再学習</small>
                            </button>
                            <button class="grade-btn grade-2" onclick="App.submitReview(2)">
                                あやふや<br><small>難しい</small>
                            </button>
                            <button class="grade-btn grade-3" onclick="App.submitReview(3)">
                                だいたい<br><small>普通</small>
                            </button>
                            <button class="grade-btn grade-4" onclick="App.submitReview(4)">
                                完璧<br><small>簡単</small>
                            </button>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
        this.render(html);
    },

    renderEmptySession() {
        const html = `
            <div class="container animate-fade-in" style="text-align: center; padding-top: 4rem;">
                <h1>セッション完了！ 🎉</h1>
                <p>予定されていたカードの学習がすべて終わりました。</p>
                <div style="margin-top: 2rem;">
                    <button class="btn btn-primary" onclick="App.navigateTo('dashboard')">ダッシュボードへ戻る</button>
                </div>
            </div>
        `;
        this.render(html);
    },

    // 5. Settings / Data Management
    renderSettings() {
        const html = `
            <div class="container animate-fade-in" style="max-width: 800px;">
                <header class="flex justify-between items-center" style="margin-bottom: 2rem;">
                    <button class="btn btn-secondary" onclick="App.navigateTo('dashboard')">
                        <i data-lucide="arrow-left"></i> 戻る
                    </button>
                    <h1>データ管理</h1>
                    <div style="width: 40px;"></div>
                </header>

                <div class="card">
                    <h3><i data-lucide="save"></i> 手動バックアップ・復元</h3>
                    <p style="color: var(--text-secondary); margin: 1rem 0;">
                        単語帳データをファイル（JSON形式）として保存します。<br>
                        PCとスマホ間でデータを移動する場合や、万が一のバックアップに使用してください。
                    </p>
                    <div class="flex gap-4" style="flex-wrap: wrap;">
                        <button class="btn btn-primary" onclick="App.exportBackup()">
                            <i data-lucide="download"></i> データを書き出す (保存)
                        </button>
                        <button class="btn btn-secondary" onclick="App.triggerImport()">
                            <i data-lucide="upload"></i> データを読み込む (復元)
                        </button>
                        <input type="file" id="importFile" accept=".json" style="display: none;" onchange="App.importBackup(this)">
                    </div>
                </div>

                <div class="card">
                    <h3><i data-lucide="cloud"></i> Google Drive 連携（手動）</h3>
                    <p style="color: var(--text-secondary); margin: 1rem 0;">
                        Google Driveを利用して、PCとiPhone等の間でデータを共有できます。<br>
                        <strong>手順:</strong><br>
                        1. 上記の「データを書き出す」でファイルを保存します。<br>
                        2. 下のボタンからGoogle Driveを開き、そのファイルをアップロードしてください。<br>
                        3. 別の端末でGoogle Driveからファイルをダウンロードし、「データを読み込む」を行ってください。
                    </p>
                    <a href="https://drive.google.com/" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="text-decoration: none;">
                        <i data-lucide="external-link"></i> Google Drive を開く
                    </a>
                </div>
            </div>
        `;
        this.render(html);
    },

    // Forms
    renderDeckForm(deck = null) {
        const html = `
            <div class="container animate-fade-in" style="max-width: 600px;">
                <h2>${deck ? '単語帳を編集' : '新しい単語帳を作成'}</h2>
                <form onsubmit="event.preventDefault(); App.saveDeck(this, ${deck ? deck.id : null})">
                    <div style="margin: 1rem 0;">
                        <label>単語帳の名前</label>
                        <input type="text" name="name" value="${deck ? deck.name : ''}" required style="width: 100%;">
                    </div>
                     <div class="flex gap-2">
                        <button type="button" class="btn btn-secondary" onclick="App.navigateTo('deckList')">キャンセル</button>
                        <button type="submit" class="btn btn-primary">保存</button>
                    </div>
                </form>
            </div>
        `;
        this.render(html);
    },

    renderCardForm(deckId, card = null) {
        // Updated to use file inputs with camera capture support
        const html = `
            <div class="container animate-fade-in" style="max-width: 600px;">
                <h2>${card ? 'カードを編集' : '新しいカードを作成'}</h2>
                <form onsubmit="event.preventDefault(); App.saveCard(this, ${deckId}, ${card ? card.id : null})">
                    <!-- Front -->
                    <div class="card" style="margin-bottom: 1rem;">
                        <h3>表面（問題）</h3>
                        <div style="margin: 1rem 0;">
                            <label>テキスト</label>
                            <textarea name="frontText" style="width: 100%; height: 80px;">${card ? card.frontText || '' : ''}</textarea>
                        </div>
                        <div style="margin: 1rem 0;">
                            <label>画像を追加/変更 (カメラ/ファイル)</label>
                            <input type="file" id="frontImageInput" accept="image/*" capture="environment" onchange="App.handleImageUpload(this, 'frontImagePreview')">
                            <input type="hidden" name="frontImage" id="frontImageParams" value="${card ? card.frontImage || '' : ''}">
                            <div id="frontImagePreview" style="margin-top: 0.5rem;">
                                ${card && card.frontImage ? `<img src="${card.frontImage}" style="max-height: 150px; border-radius: 8px;">` : ''}
                            </div>
                        </div>
                    </div>

                    <!-- Back -->
                    <div class="card" style="margin-bottom: 1rem;">
                        <h3>裏面（解答）</h3>
                        <div style="margin: 1rem 0;">
                            <label>テキスト</label>
                            <textarea name="backText" style="width: 100%; height: 80px;">${card ? card.backText || '' : ''}</textarea>
                        </div>
                        <div style="margin: 1rem 0;">
                            <label>画像を追加/変更 (カメラ/ファイル)</label>
                            <input type="file" id="backImageInput" accept="image/*" capture="environment" onchange="App.handleImageUpload(this, 'backImagePreview')">
                            <input type="hidden" name="backImage" id="backImageParams" value="${card ? card.backImage || '' : ''}">
                            <div id="backImagePreview" style="margin-top: 0.5rem;">
                                ${card && card.backImage ? `<img src="${card.backImage}" style="max-height: 150px; border-radius: 8px;">` : ''}
                            </div>
                        </div>
                    </div>

                     <div class="flex gap-2">
                        <button type="button" class="btn btn-secondary" onclick="App.manageCards(${deckId})">キャンセル</button>
                        <button type="submit" class="btn btn-primary">保存</button>
                    </div>
                </form>
            </div>
        `;
        this.render(html);
    }
};

// --- App Controller ---

const App = {
    async init() {
        try {
            await db.init();
            this.navigateTo('dashboard');
        } catch (e) {
            console.error("Simple Error", e);
            document.body.innerHTML = `<h1>起動エラー</h1><p>${e}</p>`;
        }
    },

    navigateTo(view, params = {}) {
        state.currentView = view;
        if (view === 'dashboard') UI.renderDashboard();
        if (view === 'deckList') UI.renderDeckList();
        if (view === 'settings') UI.renderSettings();
    },

    // Backup & Restore
    async exportBackup() {
        try {
            const decks = await db.getAll('decks');
            const cards = await db.getAll('cards');
            const logs = await db.getAll('logs');

            const backup = {
                version: 1,
                exportedAt: new Date().toISOString(),
                data: { decks, cards, logs }
            };

            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `deep-galaxy_backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            alert("バックアップファイルを保存しました。\n\n【Google Drive連携（共有）の方法】\n1. このファイルを Google Drive にアップロードしてください\n2. 別の端末で Google Drive からこのファイルをダウンロードしてください\n3. アプリの「読み込む」ボタンからそのファイルを選択してください");
        } catch (e) {
            console.error(e);
            alert("エクスポートに失敗しました: " + e);
        }
    },

    async triggerImport() {
        document.getElementById('importFile').click();
    },

    async importBackup(input) {
        const file = input.files[0];
        if (!file) return;

        if (!confirm("警告：現在のデータをすべて消去し、バックアップファイルの内容で上書きしますか？\n\n※この操作は取り消せません。")) {
            input.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const backup = JSON.parse(e.target.result);
                if (!backup.data || !backup.data.decks) {
                    throw new Error("無効なバックアップファイルです。");
                }

                // Transaction for atomic update
                const tx = db.instance.transaction(['decks', 'cards', 'logs'], 'readwrite');

                // Clear existing data
                await tx.objectStore('decks').clear();
                await tx.objectStore('cards').clear();
                await tx.objectStore('logs').clear();

                // Restore new data
                for (const d of backup.data.decks) await tx.objectStore('decks').put(d);
                for (const c of backup.data.cards) await tx.objectStore('cards').put(c);
                for (const l of backup.data.logs) await tx.objectStore('logs').put(l);

                tx.oncomplete = () => {
                    alert("復元が完了しました！");
                    window.location.reload(); // Reload to refresh state
                };

                tx.onerror = (err) => {
                    throw new Error(err.target.error);
                };
            } catch (err) {
                alert("インポートエラー: " + err.message);
                console.error(err);
            }
        };
        reader.readAsText(file);
    },

    // Helper: Image Upload to Base64
    handleImageUpload(input, previewId) {
        const file = input.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onloadend = () => {
            const base64 = reader.result;
            // Update hidden input
            if (previewId === 'frontImagePreview') {
                document.getElementById('frontImageParams').value = base64;
            } else {
                document.getElementById('backImageParams').value = base64;
            }
            // Update preview
            document.getElementById(previewId).innerHTML = `<img src="${base64}" style="max-height: 150px; border-radius: 8px;">`;
        };
        reader.readAsDataURL(file);
    },

    // Deck Actions
    async createDeck() {
        UI.renderDeckForm();
    },
    async editDeck(id) {
        const deck = await db.get('decks', id);
        UI.renderDeckForm(deck);
    },
    async saveDeck(form, id) {
        const name = form.name.value;
        const deck = {
            name,
            updatedAt: new Date().toISOString()
        };
        if (id) {
            deck.id = id;
            deck.createdAt = (await db.get('decks', id)).createdAt;
            await db.put('decks', deck);
        } else {
            deck.createdAt = new Date().toISOString();
            await db.add('decks', deck);
        }
        this.navigateTo('deckList');
    },
    async deleteDeck(id) {
        if (confirm("この単語帳とすべてのカードを削除しますか？")) {
            await db.delete('decks', id);
            const cards = await db.getCardsByDeck(id);
            for (let c of cards) await db.delete('cards', c.id);
            this.navigateTo('deckList');
        }
    },

    // Card Actions
    manageCards(deckId) {
        UI.renderCardManager(deckId);
    },
    async createCard(deckId) {
        UI.renderCardForm(deckId);
    },
    async editCard(id, deckId) {
        const card = await db.get('cards', id);
        UI.renderCardForm(deckId, card);
    },
    async deleteCard(id, deckId) {
        if (confirm("このカードを削除しますか？")) {
            await db.delete('cards', id);
            this.manageCards(deckId);
        }
    },
    async saveCard(form, deckId, id) {
        const cardData = {
            deckId,
            frontText: form.frontText.value,
            frontImage: form.frontImage.value,
            backText: form.backText.value,
            backImage: form.backImage.value,
            updatedAt: new Date().toISOString()
        };

        if (id) {
            const existing = await db.get('cards', id);
            Object.assign(existing, cardData);
            await db.put('cards', existing);
        } else {
            Object.assign(cardData, {
                n: 0,
                I: 0,
                EF: 2.5,
                nextReviewAt: null,
                totalSuccesses: 0,
                createdAt: new Date().toISOString()
            });
            await db.add('cards', cardData);
        }
        this.manageCards(deckId);
    },

    // Session Logic
    async startSession() {
        const cards = await Logic.getDueCards();
        if (cards.length === 0) {
            alert("今日復習すべきカードはありません！");
            return;
        }
        state.studyQueue = cards;
        state.currentCardIndex = 0;
        state.isShowingAnswer = false;
        this.renderCurrentStudyCard();
    },

    renderCurrentStudyCard() {
        if (state.currentCardIndex >= state.studyQueue.length) {
            UI.renderEmptySession();
            return;
        }
        const card = state.studyQueue[state.currentCardIndex];
        UI.renderStudyCard(card, state.studyQueue.length, state.currentCardIndex);
    },

    flipCard() {
        if (!state.isShowingAnswer) {
            state.isShowingAnswer = true;
            this.renderCurrentStudyCard();
        }
    },

    async submitReview(uiGrade) {
        // UI Grade: 1, 2, 3, 4
        // Logic q: 1, 3, 4, 5
        const qMap = { 1: 1, 2: 3, 3: 4, 4: 5 };
        const q = qMap[uiGrade];

        const card = state.studyQueue[state.currentCardIndex];

        const log = {
            cardId: card.id,
            reviewedAt: new Date().toISOString(),
            q: q,
            intervalBefore: card.I,
            efBefore: card.EF
        };

        const userStats = await Logic.getUserStats();
        let userEFMultiplier = 1.0;
        if (userStats.forgetRate > 0.35) userEFMultiplier = 0.9;
        else if (userStats.forgetRate < 0.15) userEFMultiplier = 1.1;

        const cardStats = Logic.calculateCardStats(card, userStats.forgetRate);
        let retentionMult = 1.0;
        const rScore = cardStats.retentionScore;
        if (rScore < 40) retentionMult = 0.8;
        else if (rScore > 80) retentionMult = 1.2;

        const sm2Result = Logic.calculateSM2(card, q);

        let efNew = sm2Result.EF * userEFMultiplier;
        if (efNew < 1.3) efNew = 1.3;

        let iNew = sm2Result.I;

        if (sm2Result.n > 2 && q >= 3) {
            iNew = Math.round(card.I * efNew * retentionMult);
        } else if (q < 3) {
            iNew = 1;
        } else {
            iNew = sm2Result.I;
        }

        const now = new Date();
        const nextDate = new Date();
        nextDate.setDate(now.getDate() + iNew);

        card.n = sm2Result.n;
        card.I = iNew;
        card.EF = efNew;
        card.nextReviewAt = nextDate.toISOString();
        card.lastReviewAt = now.toISOString();
        if (q >= 3) {
            card.totalSuccesses = (card.totalSuccesses || 0) + 1;
        }

        await db.put('cards', card);

        log.intervalAfter = iNew;
        log.EF = efNew;
        await db.add('logs', log);

        state.currentCardIndex++;
        state.isShowingAnswer = false;
        this.renderCurrentStudyCard();
    }
};

App.init();
