/**
 * app.js – Main Application Module
 * Initializes chessboard.js, chess.js, and Stockfish (WASM).
 * Connects all modules: board interaction, engine analysis, UI controls.
 *
 * Dependencies (loaded globally via <script> tags):
 *   - chess.js (Chess constructor)
 *   - chessboard.js (Chessboard constructor, jQuery not required with modern version)
 *   - Stockfish (Web Worker/WASM, exposes a Stockfish() function that returns a worker or interface)
 *
 * Author: Chess Analysis Project
 * Version: 1.0.0
 */

/* ---------- Global State ---------- */
const App = {
    // Core instances
    game: null,           // chess.js instance
    board: null,          // chessboard.js instance
    engine: null,         // Stockfish engine wrapper

    // UI elements (cached after DOM ready)
    el: {},

    // Configuration
    config: {
        depth: 20,
        elo: 2000,
        isEngineEnabled: false,   // whether engine analysis is active
        orientation: 'white',     // board orientation
        fen: 'start',             // current FEN (managed by chess.js)
        engineThinking: false,
    },

    // Move tracking
    moveHistory: [],      // for undo (we'll rely on chess.js undo)

    // Engine analysis cache
    analysis: {
        bestMove: null,
        evaluation: null,      // { type: 'cp'|'mate', value: number }
        principalVariation: [], // array of moves (SAN)
    },
};

/* ---------- Initialization ---------- */
document.addEventListener('DOMContentLoaded', () => {
    App.game = new Chess();

    // Cache DOM elements
    App.el = {
        board: document.getElementById('board'),
        evalBar: document.getElementById('evalBar'),
        evalFill: document.getElementById('evalFill'),
        evalText: document.getElementById('evalText'),
        moveList: document.getElementById('moveList'),
        analysisLines: document.getElementById('analysisLines'),
        depthSelect: document.getElementById('depthSelect'),
        eloSlider: document.getElementById('eloSlider'),
        eloValue: document.getElementById('eloValue'),
        startGameBtn: document.getElementById('startGameBtn'),
        newGameBtn: document.getElementById('newGameBtn'),
        undoBtn: document.getElementById('undoBtn'),
        flipBtn: document.getElementById('flipBtn'),
    };

    // Initialize chessboard
    initBoard();

    // Initialize engine (async)
    initEngine().then(() => {
        console.log('Engine ready');
        // Engine ready, but not yet started
    });

    // Bind UI events
    bindEvents();

    // Render initial board
    updateBoard();
});

/* ---------- Board Initialization ---------- */
function initBoard() {
    const config = {
        position: 'start',
        draggable: true,
        onDragStart: onDragStart,
        onDrop: onDrop,
        onSnapEnd: onSnapEnd,
        orientation: App.config.orientation,
        pieceTheme: 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png', // default theme
        showNotation: true,
    };
    App.board = Chessboard('board', config);
}

/* ---------- Board Event Handlers ---------- */
function onDragStart(source, piece, position, orientation) {
    // Do not allow moves if game is over
    if (App.game.game_over()) return false;

    // Only allow moving pieces for the current side to move
    if ((App.game.turn() === 'w' && piece.search(/^b/) !== -1) ||
        (App.game.turn() === 'b' && piece.search(/^w/) !== -1)) {
        return false;
    }

    // (Optional) highlight legal moves? Not done here.
    return true;
}

function onDrop(source, target) {
    // Attempt to make the move
    const move = App.game.move({
        from: source,
        to: target,
        promotion: 'q', // always promote to queen for simplicity; could be customized
    });

    // If illegal move, return 'snapback'
    if (move === null) return 'snapback';

    // Record move in history (for undo, we rely on chess.js undo)
    App.moveHistory.push(move);

    // Update UI (board, move list, evaluation restart)
    updateBoard();
    updateMoveList();

    // If engine analysis is enabled, start analyzing new position
    if (App.config.isEngineEnabled) {
        startEngineAnalysis();
    }

    // No snapback needed
}

function onSnapEnd() {
    // Board position is already updated by chess.js
    // Chessboard.js automatically updates piece positions on valid move
}

/* ---------- Board Update ---------- */
function updateBoard() {
    App.board.position(App.game.fen());
}

/* ---------- Engine Initialization (Stockfish WASM) ---------- */
function initEngine() {
    return new Promise((resolve, reject) => {
        // The Stockfish constructor is global from stockfish.js
        // It can be called without 'new' and returns a worker-like interface.
        App.engine = Stockfish();

        // Buffer for incomplete lines
        let outputBuffer = '';

        App.engine.onmessage = function(event) {
            const message = event.data || event; // depends on stockfish.js version
            outputBuffer += message;
            // Lines are separated by '\n'
            const lines = outputBuffer.split('\n');
            // Keep last incomplete chunk
            outputBuffer = lines.pop();
            lines.forEach(line => {
                if (line) engineOutputHandler(line);
            });
        };

        // Initialise engine with UCI mode
        App.engine.postMessage('uci');
        App.engine.postMessage('setoption name UCI_AnalyseMode value true');

        // Apply initial Elo settings (Stockfish supports UCI_Elo)
        setEngineElo(App.config.elo);

        // Wait for 'uciok' and 'readyok'
        let uciOkReceived = false;
        let readyOkReceived = false;

        function checkReady() {
            if (uciOkReceived && readyOkReceived) {
                resolve();
            }
        }

        // Override handler temporarily for init
        const initHandler = (line) => {
            if (line === 'uciok') {
                uciOkReceived = true;
                checkReady();
            } else if (line === 'readyok') {
                readyOkReceived = true;
                checkReady();
            }
            // pass to main handler as well
            engineOutputHandler(line);
        };

        // Monkey-patch onmessage temporarily
        const originalOnmessage = App.engine.onmessage;
        App.engine.onmessage = (e) => {
            const msg = e.data || e;
            outputBuffer += msg;
            const lines = outputBuffer.split('\n');
            outputBuffer = lines.pop();
            lines.forEach(line => {
                if (line) initHandler(line);
            });
        };

        // Send isready after ucinewgame
        App.engine.postMessage('ucinewgame');
        App.engine.postMessage('isready');

        // Restore original onmessage after ready (will be done in checkReady)
        // Actually we'll keep the wrapper and ensure initHandler is removed later.
        // To keep it simple, we'll just use a flag.
        setTimeout(() => {
            if (!readyOkReceived) {
                console.warn('Engine initialization timed out, continuing anyway');
                resolve();
            }
        }, 5000);
    });
}

/* ---------- Engine Communication ---------- */
function engineOutputHandler(line) {
    // console.log('[Engine]', line); // debug

    // Check for bestmove (final result of a search)
    if (line.startsWith('bestmove')) {
        const parts = line.split(' ');
        const best = parts[1];
        App.analysis.bestMove = best;
        App.config.engineThinking = false;
        return;
    }

    // Parse info lines for evaluation and pv
    if (line.startsWith('info')) {
        let evaluation = null;
        let pv = [];

        const tokens = line.split(' ');
        for (let i = 1; i < tokens.length; i++) {
            if (tokens[i] === 'score') {
                if (tokens[i + 1] === 'cp') {
                    evaluation = { type: 'cp', value: parseInt(tokens[i + 2], 10) };
                    i += 2;
                } else if (tokens[i + 1] === 'mate') {
                    evaluation = { type: 'mate', value: parseInt(tokens[i + 2], 10) };
                    i += 2;
                }
            } else if (tokens[i] === 'pv') {
                // Principal variation: moves from current position
                pv = tokens.slice(i + 1).filter(m => m.match(/^[a-h][1-8][a-h][1-8][qrbn]?/));
                break; // pv is last usually
            }
        }

        if (evaluation) {
            App.analysis.evaluation = evaluation;
            App.analysis.principalVariation = pv;
            updateEvalBar();
            updateAnalysisLines();
        }
    }
}

/* ---------- Engine Control Functions ---------- */
function setEngineElo(elo) {
    // Stockfish supports UCI_Elo from 1320 to 3190
    const clamped = Math.max(1320, Math.min(3190, elo));
    App.engine.postMessage(`setoption name UCI_LimitStrength value true`);
    App.engine.postMessage(`setoption name UCI_Elo value ${clamped}`);
}

function setEngineDepth(depth) {
    App.config.depth = depth;
}

function startEngineAnalysis() {
    if (!App.engine) return;
    // Stop any ongoing search
    App.engine.postMessage('stop');
    // Wait for bestmove? We'll just immediately start new position
    setTimeout(() => {
        App.engine.postMessage('position fen ' + App.game.fen());
        App.engine.postMessage('go depth ' + App.config.depth);
        App.config.engineThinking = true;
    }, 50);
}

function stopEngine() {
    if (App.engine) {
        App.engine.postMessage('stop');
        App.config.engineThinking = false;
    }
}

/* ---------- UI Update Functions ---------- */
function updateEvalBar() {
    if (!App.analysis.evaluation) return;

    const { type, value } = App.analysis.evaluation;
    let fillPercent = 50; // neutral
    let displayText = '0.0';

    if (type === 'cp') {
        // Centipawn evaluation: convert to a winning chance percentage (approximate)
        // Using formula: win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
        // Simpler mapping: map cp from -1000 to 1000 to 0% to 100%
        const cp = Math.max(-1000, Math.min(1000, value));
        const normalized = cp / 10; // -100 to 100
        fillPercent = 50 + (normalized * 0.5); // 0 to 100
        displayText = (value / 100).toFixed(1);
    } else if (type === 'mate') {
        // Mate evaluation: extreme ends
        if (value > 0) {
            fillPercent = 100;  // white wins
            displayText = `M${value}`;
        } else {
            fillPercent = 0;    // black wins
            displayText = `M${Math.abs(value)}`;
        }
    }

    // Clamp
    fillPercent = Math.max(0, Math.min(100, fillPercent));
    
    // Apply to UI
    if (App.el.evalFill) {
        // Vertical bar: height changes; Horizontal on mobile: width changes
        const isMobile = window.innerWidth <= 1024;
        if (isMobile) {
            App.el.evalFill.style.width = `${fillPercent}%`;
            App.el.evalFill.style.height = '100%';
        } else {
            App.el.evalFill.style.height = `${fillPercent}%`;
            App.el.evalFill.style.width = '100%';
        }
    }
    if (App.el.evalText) {
        App.el.evalText.textContent = displayText;
    }
}

function updateAnalysisLines() {
    if (!App.el.analysisLines) return;
    const pv = App.analysis.principalVariation;
    if (!pv.length) {
        App.el.analysisLines.innerHTML = '<p class="placeholder-text">Engine lines will appear here.</p>';
        return;
    }

    // Build a temporary board to get SAN moves for readability
    const tempGame = new Chess(App.game.fen());
    let html = '';
    for (const uciMove of pv) {
        // Try to convert UCI to SAN
        let san = uciMove;
        try {
            const move = tempGame.move(uciMove, { sloppy: true });
            if (move) san = move.san;
            else break;
        } catch (e) {
            break;
        }
        html += `<span class="analysis-move">${san}</span> `;
    }
    App.el.analysisLines.innerHTML = html || '<p class="placeholder-text">No line available.</p>';
}

function updateMoveList() {
    if (!App.el.moveList) return;
    const history = App.game.history({ verbose: true });
    if (history.length === 0) {
        App.el.moveList.innerHTML = '<p class="placeholder-text">No moves yet.</p>';
        return;
    }

    let html = '';
    // Group moves in pairs (white and black)
    for (let i = 0; i < history.length; i++) {
        const move = history[i];
        // move number (1-indexed)
        const moveNum = Math.floor(i / 2) + 1;
        if (i % 2 === 0) {
            html += `<span class="move-number">${moveNum}.</span> `;
        }
        html += `<span class="move-san">${move.san}</span> `;
    }
    App.el.moveList.innerHTML = html;
}

/* ---------- UI Event Bindings ---------- */
function bindEvents() {
    // Engine settings
    App.el.depthSelect.addEventListener('change', function() {
        setEngineDepth(parseInt(this.value, 10));
        if (App.config.isEngineEnabled) {
            startEngineAnalysis(); // restart search with new depth
        }
    });

    App.el.eloSlider.addEventListener('input', function() {
        const elo = parseInt(this.value, 10);
        App.config.elo = elo;
        App.el.eloValue.textContent = elo;
        setEngineElo(elo);
        // Re-analyze? Not automatically, but will take effect next search.
        // To apply immediately, restart analysis if enabled.
        if (App.config.isEngineEnabled) {
            startEngineAnalysis();
        }
    });

    // Game control buttons
    App.el.startGameBtn.addEventListener('click', () => {
        App.config.isEngineEnabled = true;
        // If a game is over, reset to start
        if (App.game.game_over()) {
            newGame();
        }
        startEngineAnalysis();
        // Disable board orientation flip? No.
        // Highlight button? Not needed.
        console.log('Engine analysis started');
    });

    App.el.newGameBtn.addEventListener('click', newGame);

    App.el.undoBtn.addEventListener('click', () => {
        if (App.config.isEngineEnabled) {
            stopEngine();
        }
        App.game.undo();
        App.moveHistory.pop();
        updateBoard();
        updateMoveList();
        // Clear analysis until next move
        App.analysis = { bestMove: null, evaluation: null, principalVariation: [] };
        updateEvalBar();
        updateAnalysisLines();
        if (App.config.isEngineEnabled) {
            startEngineAnalysis();
        }
    });

    App.el.flipBtn.addEventListener('click', () => {
        App.config.orientation = App.config.orientation === 'white' ? 'black' : 'white';
        App.board.orientation(App.config.orientation);
    });
}

function newGame() {
    stopEngine();
    App.game.reset();
    App.moveHistory = [];
    App.analysis = { bestMove: null, evaluation: null, principalVariation: [] };
    updateBoard();
    updateMoveList();
    updateEvalBar();
    updateAnalysisLines();
    // Optionally keep engine enabled
}

/* ---------- Responsive Eval Bar Update on Resize ---------- */
window.addEventListener('resize', () => {
    // Re-apply eval fill to match orientation
    updateEvalBar();
});
