const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const path = require('path'); // DODANE: Wymagane do ścieżek plików

const port = process.env.PORT || 10000;
const app = express();
app.use(cors());
app.use(express.json()); // DODANE: Pozwala serwerowi czytać dane wysłane w formacie JSON (loginy i hasła)

// DODANE: Serwowanie plików statycznych (stron HTML) z folderu 'public'
app.use(express.static(path.join(__dirname, 'public'))); 

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ... (tutaj zostaje Twoja inicjalizacja Gemini i Supabase bez zmian) ...

// --- NOWY ENDPOINT: LOGOWANIE PREMIUM ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;

    if (!supabase) {
        return res.status(500).json({ success: false, message: "Błąd serwera: Baza danych odłączona." });
    }

    try {
        // Szukamy użytkownika w tabeli Supabase
        const { data, error } = await supabase
            .from('premium_users')
            .select('*')
            .eq('username', username)
            .eq('password', password)
            .single();

        if (data) {
            // Znaleziono użytkownika - logowanie poprawne
            res.json({ success: true, redirectUrl: '/spigir_1.html' });
        } else {
            // Nie znaleziono - zły login lub hasło
            res.status(401).json({ success: false, message: "Nieprawidłowy login lub hasło." });
        }
    } catch (e) {
        console.error("Błąd logowania:", e);
        res.status(500).json({ success: false, message: "Wystąpił błąd podczas weryfikacji." });
    }
});

// ... (reszta kodu z io.on('connection') i setInterval zostaje dokładnie tak jak była) ...

io.on('connection', (socket) => {
    
    socket.on('search_rank', (rank) => {
        const queue = queues[rank];
        if (queue.length > 0) {
            const opponent = queue.shift();
            const roomId = `match_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            
            socket.join(roomId); opponent.join(roomId);
            socket.currentRoom = roomId; opponent.currentRoom = roomId;
            
            // Rejestrujemy pokój
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

    socket.on('create_room', (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;
    });

    socket.on('join_room', (roomId) => {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size === 1) {
            socket.join(roomId);
            socket.currentRoom = roomId;
            
            // Rejestrujemy pokój prywatny
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

    // --- NOWA LOGIKA AI ---
    socket.on('request_ai', () => {
        let roomId = socket.currentRoom;
        if (roomId && rooms[roomId]) {
            rooms[roomId].aiVotes++;
            // Powiadomienia na czacie
            socket.emit('chat_msg', "Zaproponowałeś użycie AI do oceny.");
            socket.to(roomId).emit('chat_msg', "Przeciwnik proponuje użycie AI do sędziowania. Kliknij przycisk AI, aby się zgodzić.");
            
            // Jeśli obaj się zgodzą
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
                // Używamy super szybkiego modelu flash
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const prompt = `Jesteś sędzią w grze. Gracz 1 napisał: "${data.r1}". Gracz 2 napisał: "${data.r2}". Czy te dwa zdania opisują ten sam powód / mają taki sam sens logiczny w kontekście psychologicznego wyboru przedmiotu? Odpowiedz tylko jednym słowem: TAK lub NIE.`;
                
                const result = await model.generateContent(prompt);
                const text = result.response.text().trim().toUpperCase();
                const isAgree = text.includes('TAK');
                
                io.to(roomId).emit('ai_evaluation_result', isAgree);
            } catch (e) {
                console.error("AI Error:", e);
                io.to(roomId).emit('chat_msg', "🤖 Wystąpił błąd podczas analizy AI. Uznaję, że kartki były niezgodne.");
                io.to(roomId).emit('ai_evaluation_result', false);
            }
        }
    });

    // Przekaźnik zdarzeń
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

    socket.on('disconnect', () => {
        if (socket.queueRank && queues[socket.queueRank]) {
            queues[socket.queueRank] = queues[socket.queueRank].filter(s => s !== socket);
        }

        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('opponent_disconnected');
            // Czyścimy pokój po wyjściu graczy
            delete rooms[socket.currentRoom];
            activeMatches--;
            if (activeMatches < 0) activeMatches = 0;
        }
    });
});

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
