const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');

const port = process.env.PORT || 10000;
const app = express();

// Konfiguracja Middleware
app.use(cors());
app.use(express.json()); // Wymagane do odbierania danych JSON w POST /api/login

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Inicjalizacja Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "brak_klucza");

// Inicjalizacja Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("Supabase zainicjowane poprawnie.");
}

// Globalny stan gry
let queues = { 1: [], 2: [], 3: [], 4: [] };
let activeMatches = 0;
const rooms = {};

// --- ENDPOINT LOGOWANIA PREMIUM ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!supabase) {
        return res.status(500).json({ success: false, message: "Baza danych niedostępna." });
    }

    try {
        const { data, error } = await supabase
            .from('premium_users')
            .select('*')
            .eq('username', username)
            .eq('password', password)
            .single();

        if (data) {
            // Logowanie udane
            res.json({ success: true });
        } else {
            // Błędne dane
            res.status(401).json({ success: false, message: "Błędny login lub hasło." });
        }
    } catch (e) {
        console.error("Błąd logowania:", e);
        res.status(500).json({ success: false, message: "Błąd serwera." });
    }
});
// --- ENDPOINT REJESTRACJI PREMIUM ---
app.post('/api/register', async (req, res) => {
    const { username, password, inviteCode } = req.body;

    if (!username || !password || !inviteCode) {
        return res.status(400).json({ success: false, message: "Wypełnij wszystkie pola." });
    }

    try {
        // 1. Sprawdzamy, czy kod istnieje i czy nie został zużyty
        const { data: codeData, error: codeError } = await supabase
            .from('invite_codes')
            .select('*')
            .eq('code', inviteCode)
            .eq('is_used', false)
            .single();

        if (!codeData || codeError) {
            return res.status(400).json({ success: false, message: "Kod dostępu jest nieprawidłowy lub został już zużyty." });
        }

        // 2. Sprawdzamy, czy login nie jest już zajęty
        const { data: userCheck } = await supabase
            .from('premium_users')
            .select('username')
            .eq('username', username)
            .single();

        if (userCheck) {
            return res.status(400).json({ success: false, message: "Ten identyfikator jest już zajęty." });
        }

        // 3. Dodajemy nowego użytkownika
        const { error: insertError } = await supabase
            .from('premium_users')
            .insert([{ username, password }]);

        if (insertError) {
            throw insertError;
        }

        // 4. Oznaczamy kod jako zużyty
        await supabase
            .from('invite_codes')
            .update({ is_used: true })
            .eq('code', inviteCode);

        res.json({ success: true, message: "Konto utworzone pomyślnie! Możesz się zalogować." });

    } catch (e) {
        console.error("Błąd rejestracji:", e);
        res.status(500).json({ success: false, message: "Błąd serwera podczas rejestracji." });
    }
});
// --- LOGIKA SOCKET.IO ---
io.on('connection', (socket) => {
    
    // Szukanie przeciwnika
    socket.on('search_rank', (rank) => {
        const queue = queues[rank];
        if (queue.length > 0) {
            const opponent = queue.shift();
            const roomId = `match_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            
            socket.join(roomId); opponent.join(roomId);
            socket.currentRoom = roomId; opponent.currentRoom = roomId;
            
            rooms[roomId] = { aiVotes: 0, aiMode: false };
            activeMatches++;

            io.to(roomId).emit('match_found', { roomId });
            opponent.emit('set_role', { isHost: true });
            socket.emit('set_role', { isHost: false });
        } else {
            queue.push(socket);
            socket.queueRank = rank;
        }
    });

    socket.on('cancel_search', () => {
        if (socket.queueRank && queues[socket.queueRank]) {
            queues[socket.queueRank] = queues[socket.queueRank].filter(s => s !== socket);
        }
    });

    // Pokoje prywatne
    socket.on('create_room', (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;
    });

    socket.on('join_room', (roomId) => {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size === 1) {
            socket.join(roomId);
            socket.currentRoom = roomId;
            rooms[roomId] = { aiVotes: 0, aiMode: false };
            activeMatches++;
            io.to(roomId).emit('match_found', { roomId });
            const clients = Array.from(room);
            io.sockets.sockets.get(clients[0]).emit('set_role', { isHost: true });
            socket.emit('set_role', { isHost: false });
        } else {
            socket.emit('error_msg', 'Pokój nie istnieje lub jest pełny!');
        }
    });

    // --- LOGIKA SĘDZIEGO AI (Gemini) ---
    socket.on('request_ai', () => {
        let roomId = socket.currentRoom;
        if (roomId && rooms[roomId]) {
            rooms[roomId].aiVotes++;
            socket.emit('chat_msg', "Zaproponowałeś użycie AI do oceny.");
            socket.to(roomId).emit('chat_msg', "Przeciwnik proponuje użycie AI do sędziowania. Kliknij przycisk AI, aby się zgodzić.");
            
            if (rooms[roomId].aiVotes >= 2) {
                rooms[roomId].aiMode = true;
                io.to(roomId).emit('ai_mode_active');
                io.to(roomId).emit('chat_msg', "🤖 Tryb Sędziego AI został aktywowany do końca gry!");
            }
        }
    });

socket.on('evaluate_ai', async (data) => {
        let roomId = socket.currentRoom;
        if (roomId && rooms[roomId] && rooms[roomId].aiMode) {
            try {
                console.log("API Key start:", (process.env.GEMINI_API_KEY || "BRAK").substring(0, 5));
                // Wymuszenie na modelu zwrotu struktury JSON (responseMimeType)
                const model = genAI.getGenerativeModel({ 
                    model: "gemini-2.5-flash",
                    generationConfig: { responseMimeType: "application/json" }
                });
                
                const prompt = `Jesteś sędzią w psychologicznej grze. Gracz 1 napisał: "${data.r1}". Gracz 2 napisał: "${data.r2}". Czy te dwa zdania mają taki sam sens logiczny w kontekście ukrytej intencji?
Zwróć poprawny JSON z dwoma polami:
"werdykt": wpisz "TAK" lub "NIE",
"uzasadnienie": krótkie, jednozdaniowe wyjaśnienie Twojej decyzji.`;
                
                const result = await model.generateContent(prompt);
                const text = result.response.text();
                
                let isAgree = false;
                let reason = "Brak uzasadnienia.";

                try {
                    const parsed = JSON.parse(text);
                    isAgree = parsed.werdykt === "TAK";
                    reason = parsed.uzasadnienie;
                } catch (parseError) {
                    console.error("Błąd parsowania JSON od AI:", parseError, text);
                    reason = "Błąd dekodowania odpowiedzi AI.";
                }
                
                io.to(roomId).emit('ai_evaluation_result', { isAgree, reason });
            } catch (e) {
                console.error("AI Error:", e);
                io.to(roomId).emit('chat_msg', "🤖 Wystąpił błąd podczas analizy AI. Uznaję, że kartki były niezgodne.");
                io.to(roomId).emit('ai_evaluation_result', { isAgree: false, reason: "Błąd serwera AI." });
            }
        }
    });

    // Przekaźnik zdarzeń gry (Relay)
    const relayEvent = (eventName) => {
        socket.on(eventName, (data) => {
            if (socket.currentRoom) {
                socket.to(socket.currentRoom).emit(eventName, data);
            }
        });
    };

    relayEvent('game_action');
    relayEvent('chat_msg');
    relayEvent('vote_action');
    relayEvent('next_round');
    relayEvent('end_game');

    // Rozłączenie
    socket.on('disconnect', () => {
        if (socket.queueRank && queues[socket.queueRank]) {
            queues[socket.queueRank] = queues[socket.queueRank].filter(s => s !== socket);
        }
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('opponent_disconnected');
            delete rooms[socket.currentRoom];
            activeMatches--;
            if (activeMatches < 0) activeMatches = 0;
        }
    });
});

// Statystyki serwera w Supabase
setInterval(async () => {
    if (supabase && activeMatches > 0) {
        let playersInGame = activeMatches * 2; 
        const { error } = await supabase.from('server_stats').insert([{ active_players: playersInGame }]);
        if (error) console.error('Błąd Supabase:', error.message);
    }
}, 60000);

server.listen(port, () => {
    console.log(`Serwer działa na porcie ${port}`);
});
