/**
 * DeepGalaxy - Offline Flashcard App
 * SM-2 algorithm + statistical correction
 */
const DB_NAME = "DeepGalaxyDB", DB_VERSION = 1;

const state = {
    currentView: 'dashboard',
    activeDeckId: null,
    studyQueue: [],
    currentCardIndex: 0,
    isShowingAnswer: false,
    returnToStudy: false,
    cardSortOrder: 'desc',
    studyDeckFilter: null,
    cardListScrollY: 0
};

// --- Database ---
const db = {
    instance: null,
    async init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = e => reject("DB Error: " + e.target.error);
            req.onupgradeneeded = e => {
                const d = e.target.result;
                if (!d.objectStoreNames.contains('decks')) {
                    d.createObjectStore('decks', { keyPath: 'id', autoIncrement: true });
                }
                if (!d.objectStoreNames.contains('cards')) {
                    const cs = d.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
                    cs.createIndex('deckId', 'deckId', { unique: false });
                    cs.createIndex('nextReviewAt', 'nextReviewAt', { unique: false });
                }
                if (!d.objectStoreNames.contains('logs')) {
                    const ls = d.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
                    ls.createIndex('cardId', 'cardId', { unique: false });
                    ls.createIndex('reviewedAt', 'reviewedAt', { unique: false });
                }
            };
            req.onsuccess = e => { this.instance = e.target.result; resolve(); };
        });
    },
    _tx(store, mode) {
        return this.instance.transaction(store, mode).objectStore(store);
    },
    getAll(s) { return new Promise(r => { const req = this._tx(s, 'readonly').getAll(); req.onsuccess = () => r(req.result); }); },
    get(s, k) { return new Promise(r => { const req = this._tx(s, 'readonly').get(k); req.onsuccess = () => r(req.result); }); },
    add(s, v) { return new Promise(r => { const req = this._tx(s, 'readwrite').add(v); req.onsuccess = () => r(req.result); }); },
    put(s, v) { return new Promise(r => { const req = this._tx(s, 'readwrite').put(v); req.onsuccess = () => r(req.result); }); },
    del(s, k) { return new Promise(r => { const req = this._tx(s, 'readwrite').delete(k); req.onsuccess = () => r(); }); },
    getCardsByDeck(deckId) {
        return new Promise(r => {
            const idx = this._tx('cards', 'readonly').index('deckId');
            const req = idx.getAll(IDBKeyRange.only(Number(deckId)));
            req.onsuccess = () => r(req.result);
        });
    }
};

// --- SM-2 Algorithm ---
const Logic = {
    now() { return new Date(); },

    calculateSM2(card, q) {
        let { n, I, EF } = card;
        let nextN, nextI, nextEF;
        if (q < 3) { nextN = 0; nextI = 1; }
        else {
            nextN = n + 1;
            if (nextN === 1) nextI = 1;
            else if (nextN === 2) nextI = 6;
            else nextI = Math.round(I * EF);
        }
        const delta = 5 - q;
        nextEF = EF + (0.1 - delta * (0.08 + delta * 0.02));
        if (nextEF < 1.3) nextEF = 1.3;
        return { n: nextN, I: nextI, EF: nextEF };
    },

    async getUserStats() {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const iso = cutoff.toISOString();
        return new Promise(r => {
            const tx = db.instance.transaction('logs', 'readonly');
            const idx = tx.objectStore('logs').index('reviewedAt');
            const req = idx.getAll(IDBKeyRange.lowerBound(iso));
            req.onsuccess = () => {
                const res = req.result;
                if (!res || !res.length) { r({ forgetRate: 0, total: 0 }); return; }
                r({ forgetRate: res.filter(l => l.q < 3).length / res.length, total: res.length });
            };
            req.onerror = () => r({ forgetRate: 0, total: 0 });
        });
    },

    calculateCardStats(card, userForgetRate) {
        if (card.n === 0) return { retention: 0, forgetRisk: 1.0, priorityScore: 100 };
        const now = new Date();
        const lastReview = card.lastReviewAt ? new Date(card.lastReviewAt) : now;
        const t = (now - lastReview) / 864e5;
        const S = Math.max(card.I * card.EF, 0.1);
        const ret = Math.exp(-t / S);
        const risk = 1 - ret;
        const rScore = Math.min(100, Math.log2(1 + (card.totalSuccesses || card.n)) * card.EF * 10);
        let overdue = 0;
        if (card.nextReviewAt) { const d = new Date(card.nextReviewAt); if (now > d) overdue = (now - d) / 864e5; }
        const ps = risk * 0.5 + ((1 - rScore / 100) * 0.3) + (1.0 / card.EF) * 0.1 + Math.log10(1 + overdue) * 0.1;
        return { retentionProbability: ret, forgetRisk: risk, retentionScore: rScore, priorityScore: ps };
    },

    async getDueCards() {
        const allCards = await db.getAll('cards');
        const now = new Date();
        const { forgetRate } = await this.getUserStats();
        const withP = allCards.map(c => ({ ...c, ...this.calculateCardStats(c, forgetRate) }));
        const due = withP.filter(c => !c.nextReviewAt || new Date(c.nextReviewAt) <= now || c.priorityScore >= 0.6);
        due.sort((a, b) => b.priorityScore - a.priorityScore);
        return due;
    }
};

// --- Image Modal ---
function openImageModal(src) {
    const overlay = document.createElement('div');
    overlay.className = 'img-modal-overlay';
    overlay.onclick = () => overlay.remove();
    const img = document.createElement('img');
    img.src = src;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'img-modal-close';
    closeBtn.innerHTML = '✕';
    closeBtn.onclick = e => { e.stopPropagation(); overlay.remove(); };
    overlay.appendChild(img);
    overlay.appendChild(closeBtn);
    document.body.appendChild(overlay);
}

// --- UI ---
const UI = {
    app: document.getElementById('app'),
    render(t) { this.app.innerHTML = t; lucide.createIcons(); },

    // Dashboard
    async renderDashboard() {
        const stats = await Logic.getUserStats();
        const [logs, cards, dueCards, decks] = await Promise.all([
            db.getAll('logs'), db.getAll('cards'), Logic.getDueCards(), db.getAll('decks')
        ]);
        const now = new Date();
        const t7 = now.getTime() - 7 * 864e5;
        const l7 = logs.filter(l => new Date(l.reviewedAt).getTime() > t7);
        const rate7d = l7.length ? Math.round(l7.filter(l => l.q >= 3).length / l7.length * 100) : 0;

        const deckOpts = decks.map(d => `<option value="${d.id}" ${state.studyDeckFilter == d.id ? 'selected' : ''}>${d.name}</option>`).join('');

        this.render(`
        <div class="container animate-fade-in">
            <header class="flex justify-between items-center" style="margin-bottom:2rem">
                <h1>DeepGalaxy</h1>
                <button class="btn btn-secondary" onclick="App.navigateTo('settings')" style="min-height:48px"><i data-lucide="settings"></i> データ管理</button>
            </header>
            <div style="margin-bottom:2rem">
                <button class="btn btn-primary" onclick="App.navigateTo('deckList')" style="width:100%;font-size:1.2rem;padding:1.25rem 2rem;min-height:56px">
                    <i data-lucide="layers"></i> 単語帳管理
                </button>
            </div>
            <div class="stats-grid">
                <div class="stat-card">
                    <h3>今日の復習</h3>
                    <div class="stat-value">${dueCards.length}</div>
                    <button class="btn btn-secondary" style="margin-top:.5rem;font-size:.9rem" onclick="App.showDueList()"><i data-lucide="list"></i> 一覧を見る</button>
                </div>
                <div class="stat-card"><h3>定着率 (7日)</h3><div class="stat-value">${rate7d}%</div><small>忘却率: ${(stats.forgetRate * 100).toFixed(1)}%</small></div>
            </div>
            <div class="card" style="text-align:center;padding:3rem 2rem">
                <h2>学習を始めましょう</h2>
                <p style="color:var(--txt2);margin:1rem 0">今日優先すべきカードは ${dueCards.length} 枚です。</p>
                <div style="margin:1rem 0">
                    <label style="color:var(--txt2);font-size:.9rem">優先する単語帳：</label>
                    <select id="deckFilter" onchange="App.setDeckFilter(this.value)" style="padding:.5rem;min-width:160px">
                        <option value="">自動（おまかせ）</option>
                        ${deckOpts}
                    </select>
                </div>
                <button class="btn btn-primary" style="font-size:1.25rem;padding:1rem 3rem" onclick="App.startSession()"><i data-lucide="play"></i> 学習開始</button>
            </div>
        </div>`);
    },

    // Deck List (⑦ show card count)
    async renderDeckList() {
        const decks = await db.getAll('decks');
        const allCards = await db.getAll('cards');
        const countMap = {};
        allCards.forEach(c => { countMap[c.deckId] = (countMap[c.deckId] || 0) + 1; });

        const rows = decks.map(d => `
        <div class="card flex justify-between items-center">
            <div>
                <h3>${d.name}（${countMap[d.id] || 0}枚）</h3>
                <p style="color:var(--txt2)">作成日: ${new Date(d.createdAt).toLocaleDateString()}</p>
            </div>
            <div class="flex gap-2">
                <button class="btn btn-secondary" onclick="App.editDeck(${d.id})"><i data-lucide="edit"></i> 編集</button>
                <button class="btn btn-secondary" onclick="App.manageCards(${d.id})"><i data-lucide="list"></i> カード一覧</button>
                <button class="btn btn-primary" onclick="App.createCard(${d.id})"><i data-lucide="plus"></i> カード追加</button>
                <button class="btn btn-danger" onclick="App.deleteDeck(${d.id})"><i data-lucide="trash"></i></button>
            </div>
        </div>`).join('');

        this.render(`
        <div class="container animate-fade-in">
            <header class="flex justify-between items-center" style="margin-bottom:2rem">
                <button class="btn btn-secondary" onclick="App.navigateTo('dashboard')"><i data-lucide="arrow-left"></i> 戻る</button>
                <h1>単語帳一覧</h1>
                <button class="btn btn-primary" onclick="App.createDeck()"><i data-lucide="plus"></i> 新規作成</button>
            </header>
            <div class="flex flex-col gap-4">${rows || '<p style="text-align:center;color:var(--txt2)">単語帳がありません。</p>'}</div>
        </div>`);
    },

    // Card Manager (sort + count + scroll restore)
    async renderCardManager(deckId) {
        state.activeDeckId = deckId;
        const deck = await db.get('decks', deckId);
        let cards = await db.getCardsByDeck(deckId);
        const total = cards.length;

        cards.sort((a, b) => {
            const ta = new Date(a.createdAt || 0).getTime();
            const tb = new Date(b.createdAt || 0).getTime();
            return state.cardSortOrder === 'desc' ? tb - ta : ta - tb;
        });

        const rows = cards.map(c => `
        <div class="card">
            <div class="flex justify-between">
                <div style="flex:1">
                    <strong>表:</strong> ${c.frontText || '(画像)'}<br>
                    <small style="color:var(--txt2)">EF: ${c.EF.toFixed(2)} | 次回: ${c.nextReviewAt ? new Date(c.nextReviewAt).toLocaleDateString() : '未学習'}</small>
                </div>
                <div class="flex gap-2">
                    <button class="btn btn-secondary" onclick="App.editCard(${c.id},${deckId})"><i data-lucide="edit"></i></button>
                    <button class="btn btn-danger" onclick="App.deleteCard(${c.id},${deckId})"><i data-lucide="trash"></i></button>
                </div>
            </div>
        </div>`).join('');

        this.render(`
        <div class="container animate-fade-in" id="cardListContainer">
            <header class="flex justify-between items-center" style="margin-bottom:2rem">
                <button class="btn btn-secondary" onclick="App.navigateTo('deckList')"><i data-lucide="arrow-left"></i> 戻る</button>
                <h1>${deck.name}（${total}枚）</h1>
                <button class="btn btn-primary" onclick="App.createCard(${deckId})"><i data-lucide="plus"></i> カード追加</button>
            </header>
            <div style="margin-bottom:1rem;display:flex;justify-content:flex-end;align-items:center;gap:.5rem">
                <span style="color:var(--txt2);font-size:.85rem">並び替え：</span>
                <div class="sort-toggle">
                    <button class="${state.cardSortOrder === 'desc' ? 'active' : ''}" onclick="App.setSortOrder('desc',${deckId})">新しい順</button>
                    <button class="${state.cardSortOrder === 'asc' ? 'active' : ''}" onclick="App.setSortOrder('asc',${deckId})">古い順</button>
                </div>
            </div>
            <div class="flex flex-col gap-4">${rows || '<p style="text-align:center;color:var(--txt2)">カードがありません。</p>'}</div>
        </div>`);

        // Restore scroll position
        if (state.cardListScrollY > 0) {
            requestAnimationFrame(() => window.scrollTo(0, state.cardListScrollY));
            state.cardListScrollY = 0;
        }
    },

    // Study Card (text→image order, per-card imgSize)
    renderStudyCard(card, total, current) {
        const sz = card.imgSize || 'medium';
        const szMap = { small: '200px', medium: '400px', large: '600px' };
        const maxH = szMap[sz] || '400px';
        const mkImg = (src, alt) => {
            if (!src) return '';
            return `<div class="study-img-wrap">
                <img src="${src}" alt="${alt}" class="study-img" style="max-height:${maxH}">
                <button class="img-zoom-btn" onclick="event.stopPropagation();openImageModal('${src}')" title="拡大表示">🔍</button>
            </div>`;
        };
        // Text first, then image
        const front = (card.frontText ? `<p>${card.frontText}</p>` : '') + mkImg(card.frontImage, '表');
        const back = (card.backText ? `<p>${card.backText}</p>` : '') + mkImg(card.backImage, '裏');

        this.render(`
        <div class="container animate-fade-in" style="min-height:100vh;display:flex;flex-direction:column">
            <div class="flex justify-between items-center">
                <button class="btn btn-secondary" onclick="App.navigateTo('dashboard')">終了</button>
                <span>カード ${current + 1} / ${total}</span>
                <span>スコア: ${Math.round(card.priorityScore * 100) || 0}</span>
            </div>
            <div class="study-container" style="flex:1;display:flex;flex-direction:column;justify-content:center">
                <div class="flashcard" onclick="App.flipCard()">
                    <div class="flashcard-content">
                        <div style="color:var(--txt2);font-size:.9rem;margin-bottom:1rem">表（問題）</div>
                        ${front}
                        ${state.isShowingAnswer ? `
                            <hr style="border:0;border-top:1px solid var(--brd);margin:2rem 0">
                            <div style="color:var(--txt2);font-size:.9rem;margin-bottom:1rem">裏（解答）</div>
                            <div class="animate-fade-in">${back}</div>
                        ` : '<p style="margin-top:2rem;color:var(--txt2);font-size:.9rem">(タップして解答を表示)</p>'}
                    </div>
                </div>
                ${state.isShowingAnswer ? `
                <div style="margin-top:1rem;display:flex;gap:1rem;justify-content:center">
                    <button class="btn btn-secondary" onclick="App.editCardFromStudy(${card.id},${card.deckId})"><i data-lucide="edit"></i> 編集</button>
                    <button class="btn btn-danger" onclick="App.deleteCardFromStudy(${card.id})"><i data-lucide="trash"></i> 削除</button>
                </div>
                <div class="action-bar animate-fade-in">
                    <button class="grade-btn grade-1" onclick="App.submitReview(1)">再学習</button>
                    <button class="grade-btn grade-2" onclick="App.submitReview(2)">難しい</button>
                    <button class="grade-btn grade-3" onclick="App.submitReview(3)">普通</button>
                    <button class="grade-btn grade-4" onclick="App.submitReview(4)">簡単</button>
                </div>` : ''}
            </div>
        </div>`);
    },

    renderEmptySession() {
        this.render(`
        <div class="container animate-fade-in" style="text-align:center;padding-top:4rem">
            <h1>セッション完了！ 🎉</h1>
            <p>予定されていたカードの学習がすべて終わりました。</p>
            <div style="margin-top:2rem"><button class="btn btn-primary" onclick="App.navigateTo('dashboard')">ダッシュボードへ戻る</button></div>
        </div>`);
    },

    // Settings
    renderSettings() {
        this.render(`
        <div class="container animate-fade-in" style="max-width:800px">
            <header class="flex justify-between items-center" style="margin-bottom:2rem">
                <button class="btn btn-secondary" onclick="App.navigateTo('dashboard')"><i data-lucide="arrow-left"></i> 戻る</button>
                <h1>データ管理</h1>
                <div style="width:40px"></div>
            </header>
            <div class="card">
                <h3><i data-lucide="save"></i> 手動バックアップ・復元</h3>
                <p style="color:var(--txt2);margin:1rem 0">
                    単語帳データをファイルとして保存します。<br>
                    ファイル名は常に <strong>deepgalaxy_backup.json</strong> で固定です。<br>
                    同じ名前で保存されます。Google Driveに置くと自動で上書きされます。
                </p>
                <div class="flex gap-4" style="flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="App.exportBackup()"><i data-lucide="download"></i> データを書き出す</button>
                    <button class="btn btn-secondary" onclick="App.triggerImport()"><i data-lucide="upload"></i> データを読み込む</button>
                    <input type="file" id="importFile" accept=".json" style="display:none" onchange="App.importBackup(this)">
                </div>
            </div>
            <div class="card">
                <h3><i data-lucide="cloud"></i> Google Drive 連携（手動）</h3>
                <p style="color:var(--txt2);margin:1rem 0">
                    上記でバックアップしたファイルをGoogle Drive経由で別端末と共有できます。<br>
                    PC版Google Driveデスクトップアプリを使う場合：同期フォルダにバックアップファイルを保存するだけでOKです。
                </p>
                <a href="https://drive.google.com/" target="_blank" rel="noopener noreferrer" class="btn btn-secondary" style="text-decoration:none"><i data-lucide="external-link"></i> Google Drive を開く</a>
            </div>
        </div>`);
    },

    // Due List
    async renderDueList() {
        const [dueCards, decks] = await Promise.all([Logic.getDueCards(), db.getAll('decks')]);
        const dm = {}; decks.forEach(d => dm[d.id] = d.name);
        const rows = dueCards.map(c => `
        <div class="card flex justify-between items-center">
            <div style="flex:1">
                <span style="font-size:.8rem;color:var(--txt2)">${dm[c.deckId] || '?'}</span>
                <div style="font-weight:bold;margin-top:.25rem">${c.frontText || '(画像カード)'}</div>
                <small style="color:var(--txt2)">次回: ${c.nextReviewAt ? new Date(c.nextReviewAt).toLocaleDateString() : '新規'}</small>
            </div>
        </div>`).join('');

        this.render(`
        <div class="container animate-fade-in">
            <header class="flex justify-between items-center" style="margin-bottom:2rem">
                <button class="btn btn-secondary" onclick="App.navigateTo('dashboard')"><i data-lucide="arrow-left"></i> 戻る</button>
                <h1>今日の復習一覧 (${dueCards.length})</h1>
                <div style="width:40px"></div>
            </header>
            <div style="margin-bottom:2rem;text-align:center"><button class="btn btn-primary" style="padding:1rem 3rem" onclick="App.startSession()"><i data-lucide="play"></i> 学習を開始する</button></div>
            <div class="flex flex-col gap-4">${rows || '<p style="text-align:center">復習が必要なカードはありません。</p>'}</div>
        </div>`);
    },

    // Forms
    renderDeckForm(deck = null) {
        this.render(`
        <div class="container animate-fade-in" style="max-width:600px">
            <h2>${deck ? '単語帳を編集' : '新しい単語帳を作成'}</h2>
            <form onsubmit="event.preventDefault();App.saveDeck(this,${deck ? deck.id : null})">
                <div style="margin:1rem 0"><label>単語帳の名前</label><input type="text" name="name" value="${deck ? deck.name : ''}" required style="width:100%"></div>
                <div class="flex gap-2">
                    <button type="button" class="btn btn-secondary" onclick="App.navigateTo('deckList')">キャンセル</button>
                    <button type="submit" class="btn btn-primary">保存</button>
                </div>
            </form>
        </div>`);
    },

    // Card Form (image delete, imgSize slider)
    renderCardForm(deckId, card = null) {
        const curSize = card?.imgSize || 'medium';
        const szLabels = { small: '小', medium: '中', large: '大' };
        const szIdx = { small: 0, medium: 1, large: 2 };

        const mkImgSection = (side, label, hiddenId, previewId, imgVal) => {
            const hasImg = !!(imgVal);
            return `
                <div style="margin:1rem 0">
                    <label>画像（カメラ撮影 または 写真選択）</label>
                    <input type="file" accept="image/*" onchange="App.handleImageUpload(this,'${previewId}')">
                    <input type="hidden" name="${side}Image" id="${hiddenId}" value="${imgVal || ''}">
                    <div id="${previewId}" style="margin-top:.5rem">${hasImg ? `<img src="${imgVal}" style="max-height:150px;border-radius:8px">` : ''}</div>
                    ${hasImg ? `<button type="button" class="btn btn-danger" style="margin-top:.5rem;font-size:.85rem" onclick="App.removeImage('${side}','${hiddenId}','${previewId}')">
                        <i data-lucide="x"></i> 画像を削除
                    </button>` : ''}
                </div>`;
        };

        this.render(`
        <div class="container animate-fade-in" style="max-width:600px">
            <h2>${card ? 'カードを編集' : '新しいカードを作成'}</h2>
            <form onsubmit="event.preventDefault();App.saveCard(this,${deckId},${card ? card.id : null})">
                <div class="card" style="margin-bottom:1rem">
                    <h3>表面（問題）</h3>
                    <div style="margin:1rem 0"><label>テキスト</label><textarea name="frontText" style="width:100%;height:80px">${card ? card.frontText || '' : ''}</textarea></div>
                    ${mkImgSection('front', '表面', 'frontImageParams', 'frontImagePreview', card?.frontImage)}
                </div>
                <div class="card" style="margin-bottom:1rem">
                    <h3>裏面（解答）</h3>
                    <div style="margin:1rem 0"><label>テキスト</label><textarea name="backText" style="width:100%;height:80px">${card ? card.backText || '' : ''}</textarea></div>
                    ${mkImgSection('back', '裏面', 'backImageParams', 'backImagePreview', card?.backImage)}
                </div>
                <div class="card" style="margin-bottom:1rem">
                    <h3>画像サイズ</h3>
                    <p style="color:var(--txt2);font-size:.85rem;margin:.5rem 0">学習画面での画像の表示サイズを選択してください。</p>
                    <input type="hidden" name="imgSize" id="imgSizeVal" value="${curSize}">
                    <div style="display:flex;align-items:center;gap:1rem;margin-top:.5rem">
                        <input type="range" id="imgSizeRange" min="0" max="2" step="1" value="${szIdx[curSize]}" style="flex:1;min-height:44px;accent-color:var(--pri)" oninput="App.updateImgSizeLabel(this.value)">
                        <span id="imgSizeLabel" style="min-width:2em;font-weight:600;font-size:1.1rem">${szLabels[curSize]}</span>
                    </div>
                </div>
                <div class="flex gap-2">
                    <button type="button" class="btn btn-secondary" onclick="${state.returnToStudy ? 'App.returnToStudy()' : `App.manageCards(${deckId})`}">キャンセル</button>
                    <button type="submit" class="btn btn-primary">保存</button>
                </div>
            </form>
        </div>`);
    }
};

// --- App Controller ---
const App = {
    async init() {
        try { await db.init(); this.navigateTo('dashboard'); }
        catch (e) { document.body.innerHTML = `<h1>起動エラー</h1><p>${e}</p>`; }
    },

    navigateTo(view) {
        state.currentView = view;
        if (view !== 'cardForm') state.returnToStudy = false;
        if (view === 'dashboard') UI.renderDashboard();
        else if (view === 'deckList') UI.renderDeckList();
        else if (view === 'settings') UI.renderSettings();
        else if (view === 'dueList') UI.renderDueList();
    },

    setSortOrder(order, deckId) { state.cardSortOrder = order; UI.renderCardManager(deckId); },
    setDeckFilter(val) { state.studyDeckFilter = val || null; },

    // Image upload
    handleImageUpload(input, previewId) {
        const file = input.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onloadend = () => {
            const b64 = reader.result;
            const hiddenId = previewId === 'frontImagePreview' ? 'frontImageParams' : 'backImageParams';
            document.getElementById(hiddenId).value = b64;
            document.getElementById(previewId).innerHTML = `<img src="${b64}" style="max-height:150px;border-radius:8px">`;
            // Show delete button
            const delBtn = document.querySelector(`[onclick*="${previewId}"].btn-danger`);
            if (!delBtn) {
                const side = previewId === 'frontImagePreview' ? 'front' : 'back';
                const btn = document.createElement('button');
                btn.type = 'button'; btn.className = 'btn btn-danger'; btn.style.cssText = 'margin-top:.5rem;font-size:.85rem';
                btn.onclick = () => App.removeImage(side, hiddenId, previewId);
                btn.innerHTML = '<i data-lucide="x"></i> 画像を削除';
                document.getElementById(previewId).parentElement.appendChild(btn);
                lucide.createIcons();
            }
        };
        reader.readAsDataURL(file);
    },

    // Image removal
    removeImage(side, hiddenId, previewId) {
        if (!confirm('この画像を削除しますか？')) return;
        document.getElementById(hiddenId).value = '';
        document.getElementById(previewId).innerHTML = '';
        // Remove delete button
        const btns = document.getElementById(previewId).parentElement.querySelectorAll('.btn-danger');
        btns.forEach(b => b.remove());
    },

    // Image size slider label
    updateImgSizeLabel(val) {
        const sizes = ['small', 'medium', 'large'];
        const labels = ['小', '中', '大'];
        document.getElementById('imgSizeVal').value = sizes[val];
        document.getElementById('imgSizeLabel').textContent = labels[val];
    },

    // Backup (fixed filename)
    async exportBackup() {
        try {
            const [decks, cards, logs] = await Promise.all([db.getAll('decks'), db.getAll('cards'), db.getAll('logs')]);
            const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: { decks, cards, logs } })], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = 'deepgalaxy_backup.json';
            document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
            alert("deepgalaxy_backup.json として保存しました。\n\n毎回同じファイル名で保存されます。\nGoogle Driveの同期フォルダに置くと自動的に上書きされます。");
        } catch (e) { alert("エクスポート失敗: " + e); }
    },
    triggerImport() { document.getElementById('importFile').click(); },
    async importBackup(input) {
        const file = input.files[0]; if (!file) return;
        if (!confirm("現在のデータをすべて消去し、バックアップファイルの内容で上書きしますか？\n\nこの操作は取り消せません。")) { input.value = ''; return; }
        const reader = new FileReader();
        reader.onload = async e => {
            try {
                const bk = JSON.parse(e.target.result);
                if (!bk.data || !bk.data.decks) throw new Error("無効なファイルです");
                const tx = db.instance.transaction(['decks', 'cards', 'logs'], 'readwrite');
                await tx.objectStore('decks').clear(); await tx.objectStore('cards').clear(); await tx.objectStore('logs').clear();
                for (const d of bk.data.decks) await tx.objectStore('decks').put(d);
                for (const c of bk.data.cards) await tx.objectStore('cards').put(c);
                for (const l of bk.data.logs) await tx.objectStore('logs').put(l);
                tx.oncomplete = () => { alert("復元完了！"); location.reload(); };
            } catch (err) { alert("インポートエラー: " + err.message); }
        };
        reader.readAsText(file);
    },

    // Deck CRUD
    createDeck() { UI.renderDeckForm(); },
    async editDeck(id) { UI.renderDeckForm(await db.get('decks', id)); },
    async saveDeck(form, id) {
        const deck = { name: form.name.value, updatedAt: new Date().toISOString() };
        if (id) { deck.id = id; deck.createdAt = (await db.get('decks', id)).createdAt; await db.put('decks', deck); }
        else { deck.createdAt = new Date().toISOString(); await db.add('decks', deck); }
        this.navigateTo('deckList');
    },
    async deleteDeck(id) {
        if (!confirm("この単語帳とすべてのカードを削除しますか？")) return;
        await db.del('decks', id);
        const cards = await db.getCardsByDeck(id);
        for (const c of cards) await db.del('cards', c.id);
        this.navigateTo('deckList');
    },

    // Card CRUD (save scroll position before leaving list)
    manageCards(deckId) { UI.renderCardManager(deckId); },
    createCard(deckId) { state.cardListScrollY = window.scrollY; UI.renderCardForm(deckId); },
    async editCard(id, deckId) { state.cardListScrollY = window.scrollY; state.returnToStudy = false; UI.renderCardForm(deckId, await db.get('cards', id)); },
    async deleteCard(id, deckId) { if (confirm("このカードを削除しますか？")) { await db.del('cards', id); this.manageCards(deckId); } },

    // ① Duplicate check + save
    async saveCard(form, deckId, id) {
        const frontText = form.frontText.value.trim();
        const backText = form.backText.value.trim();
        const frontImage = form.frontImage.value;
        const backImage = form.backImage.value;

        // Duplicate check on new cards only
        if (!id && (frontText || backText)) {
            const existing = await db.getCardsByDeck(deckId);
            const dupFront = frontText && existing.some(c => c.frontText && c.frontText.trim() === frontText);
            const dupBack = backText && existing.some(c => c.backText && c.backText.trim() === backText);
            if (dupFront && dupBack) {
                if (!confirm("同じ表面・裏面のカードがすでに存在します。\n本当に作成しますか？")) return;
            } else if (dupFront) {
                if (!confirm("同じ表面（問題）のカードがすでに存在します。\n本当に作成しますか？")) return;
            } else if (dupBack) {
                if (!confirm("同じ裏面（解答）のカードがすでに存在します。\n本当に作成しますか？")) return;
            }
        }

        const imgSize = form.imgSize ? form.imgSize.value : 'medium';
        const cardData = { deckId, frontText, frontImage, backText, backImage, imgSize, updatedAt: new Date().toISOString() };
        if (id) {
            const ex = await db.get('cards', id);
            Object.assign(ex, cardData);
            await db.put('cards', ex);
            if (state.returnToStudy && state.studyQueue[state.currentCardIndex]?.id === id)
                Object.assign(state.studyQueue[state.currentCardIndex], ex);
        } else {
            Object.assign(cardData, { n: 0, I: 0, EF: 2.5, nextReviewAt: null, totalSuccesses: 0, createdAt: new Date().toISOString() });
            await db.add('cards', cardData);
        }
        if (state.returnToStudy) { state.returnToStudy = false; this.renderCurrentStudyCard(); }
        else this.manageCards(deckId);
    },

    // Study
    showDueList() { this.navigateTo('dueList'); },
    async editCardFromStudy(id, deckId) { state.returnToStudy = true; UI.renderCardForm(deckId, await db.get('cards', id)); },
    returnToStudy() { state.returnToStudy = false; this.renderCurrentStudyCard(); },
    async deleteCardFromStudy(id) {
        if (!confirm("このカードを削除しますか？\n（次のカードへ進みます）")) return;
        await db.del('cards', id);
        state.studyQueue.splice(state.currentCardIndex, 1);
        if (!state.studyQueue.length || state.currentCardIndex >= state.studyQueue.length) { UI.renderEmptySession(); return; }
        state.isShowingAnswer = false; this.renderCurrentStudyCard();
    },

    // ③ Start session with deck filter
    async startSession() {
        let cards = await Logic.getDueCards();
        if (!cards.length) { alert("今日復習すべきカードはありません！"); return; }
        // If deck filter is set, push those cards to front
        if (state.studyDeckFilter) {
            const filterId = Number(state.studyDeckFilter);
            const priority = cards.filter(c => c.deckId === filterId);
            const rest = cards.filter(c => c.deckId !== filterId);
            cards = [...priority, ...rest];
        }
        state.studyQueue = cards; state.currentCardIndex = 0; state.isShowingAnswer = false;
        this.renderCurrentStudyCard();
    },

    renderCurrentStudyCard() {
        if (state.currentCardIndex >= state.studyQueue.length) { UI.renderEmptySession(); return; }
        UI.renderStudyCard(state.studyQueue[state.currentCardIndex], state.studyQueue.length, state.currentCardIndex);
    },

    flipCard() { if (!state.isShowingAnswer) { state.isShowingAnswer = true; this.renderCurrentStudyCard(); } },

    async submitReview(uiGrade) {
        const qMap = { 1: 1, 2: 3, 3: 4, 4: 5 };
        const q = qMap[uiGrade];
        const card = state.studyQueue[state.currentCardIndex];
        const log = { cardId: card.id, reviewedAt: new Date().toISOString(), q, intervalBefore: card.I, efBefore: card.EF };

        const userStats = await Logic.getUserStats();
        let eMult = 1.0;
        if (userStats.forgetRate > 0.35) eMult = 0.9;
        else if (userStats.forgetRate < 0.15) eMult = 1.1;

        const cs = Logic.calculateCardStats(card, userStats.forgetRate);
        let rMult = 1.0;
        if (cs.retentionScore < 40) rMult = 0.8;
        else if (cs.retentionScore > 80) rMult = 1.2;

        const sm2 = Logic.calculateSM2(card, q);
        let efNew = Math.max(sm2.EF * eMult, 1.3);
        let iNew;
        if (sm2.n > 2 && q >= 3) iNew = Math.round(card.I * efNew * rMult);
        else if (q < 3) iNew = 1;
        else iNew = sm2.I;

        const now = new Date(), next = new Date(); next.setDate(now.getDate() + iNew);
        card.n = sm2.n; card.I = iNew; card.EF = efNew;
        card.nextReviewAt = next.toISOString(); card.lastReviewAt = now.toISOString();
        if (q >= 3) card.totalSuccesses = (card.totalSuccesses || 0) + 1;

        await db.put('cards', card);
        log.intervalAfter = iNew; log.EF = efNew;
        await db.add('logs', log);

        state.currentCardIndex++; state.isShowingAnswer = false;
        this.renderCurrentStudyCard();
    }
};

App.init();
