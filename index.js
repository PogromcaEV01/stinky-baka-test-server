const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai'); // NOWE
const cors = require('cors');

const port = process.env.PORT || 10000;
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Inicjalizacja Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "brak_klucza");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;
if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("Supabase zainicjowane poprawnie.");
}

let queues = { 1: [], 2: [], 3: [], 4: [] };
let activeMatches = 0;

// Obiekt do przechowywania danych o pokojach (np. zgoda na AI)
const rooms = {};

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
        console.log(`[AI Sędzia] Prośba od gracza w pokoju: ${roomId}`);

        if (roomId) {
            // Zabezpieczenie: jeśli pokój z jakiegoś powodu nie istnieje w obiekcie, stwórz go
            if (!rooms[roomId]) {
                rooms[roomId] = { aiVotes: 0, aiMode: false };
            }

            // Zabezpieczenie przed wielokrotnym wysłaniem sygnału przez jednego gracza (np. lagi)
            if (!socket.aiVoteCast) {
                socket.aiVoteCast = true;
                rooms[roomId].aiVotes++;
                console.log(`[AI Sędzia] Liczba głosów w ${roomId}: ${rooms[roomId].aiVotes}/2`);

                // Informacje na czacie
                socket.emit('chat_msg', "🤖 Zaproponowałeś użycie AI. Czekamy na przeciwnika.");
                socket.to(roomId).emit('chat_msg', "🤖 Przeciwnik proponuje AI. Kliknij 'ZDAJ SIĘ NA AI'.");

                // Gdy mamy 2 głosy
                if (rooms[roomId].aiVotes >= 2) {
                    rooms[roomId].aiMode = true;
                    console.log(`[AI Sędzia] Oba głosy zebrane. Aktywacja dla: ${roomId}`);
                    
                    // Wymuszamy wysłanie sygnału do absolutnie wszystkich w pokoju
                    io.in(roomId).emit('ai_mode_active');
                    io.in(roomId).emit('chat_msg', "🤖 ZGODA! Tryb Sędziego AI jest aktywny do końca gry.");
                }
            }
        } else {
            console.log("[AI Sędzia] Błąd: Brak ID pokoju dla tego socketu.");
        }
    });

    socket.on('evaluate_ai', async (data) => {
        let roomId = socket.currentRoom;
        console.log(`[AI Sędzia] Rozpoczynam analizę dla pokoju: ${roomId}`);
        
        if (roomId && rooms[roomId] && rooms[roomId].aiMode) {
            try {
                // Sprawdzamy, czy Gemini jest poprawne zainicjowane
                if (!genAI) throw new Error("Gemini API nie zostało zainicjowane.");

                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                const prompt = `Jesteś sędzią w grze. Gracz 1 napisał: "${data.r1}". Gracz 2 napisał: "${data.r2}". Czy te dwa zdania opisują ten sam powód / mają taki sam sens logiczny w kontekście psychologicznego wyboru przedmiotu? Odpowiedz tylko jednym słowem: TAK lub NIE.`;
                
                const result = await model.generateContent(prompt);
                const text = result.response.text().trim().toUpperCase();
                console.log(`[AI Sędzia] Werdykt: ${text}`);
                
                const isAgree = text.includes('TAK');
                io.in(roomId).emit('ai_evaluation_result', isAgree);
            } catch (e) {
                console.error("[AI Sędzia] Krytyczny błąd API:", e.message);
                io.in(roomId).emit('chat_msg', "🤖 Wystąpił błąd komunikacji z API. Automatycznie uznaję brak zgody.");
                io.in(roomId).emit('ai_evaluation_result', false);
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
