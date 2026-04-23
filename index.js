const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const port = process.env.PORT || 10000;
const app = express();
app.use(cors()); // Zezwala na połączenia z innych domen (jeśli frontend masz gdzie indziej)

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// 1. Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
let supabase = null;

if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
    console.log("Supabase zainicjowane poprawnie.");
} else {
    console.log("Brak kluczy Supabase. Działam w trybie offline/symulacji.");
}

// 2. Stan serwera
let queues = { 1: [], 2: [], 3: [], 4: [] }; // Kolejki dla rang
let activeMatches = 0;

// 3. Logika Socket.io
io.on('connection', (socket) => {
    let currentRoom = null;

    // TRYB RANKINGOWY: Szukanie przeciwnika
    socket.on('search_rank', (rank) => {
        const queue = queues[rank];
        
        if (queue.length > 0) {
            // Znaleziono przeciwnika
            const opponent = queue.shift();
            const roomId = `match_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            
            // Dołącz obu graczy do pokoju
            socket.join(roomId);
            opponent.join(roomId);
            
            socket.currentRoom = roomId;
            opponent.currentRoom = roomId;
            activeMatches++;

            // Informujemy graczy, że mecz się zaczął. 
            // Przeciwnik z kolejki staje się "Hostem" (zaczyna nalewać)
            io.to(roomId).emit('match_found', { roomId });
            opponent.emit('set_role', { isHost: true });
            socket.emit('set_role', { isHost: false });
            
        } else {
            // Brak przeciwnika - dodaj do kolejki
            queue.push(socket);
            socket.queueRank = rank;
        }
    });

    socket.on('cancel_search', () => {
        if (socket.queueRank && queues[socket.queueRank]) {
            queues[socket.queueRank] = queues[socket.queueRank].filter(s => s !== socket);
        }
    });

    // GRA PRYWATNA: Tworzenie i dołączanie
    socket.on('create_room', (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;
    });

    socket.on('join_room', (roomId) => {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (room && room.size === 1) {
            socket.join(roomId);
            socket.currentRoom = roomId;
            activeMatches++;
            
            io.to(roomId).emit('match_found', { roomId });
            
            // Hostem jest ten, kto stworzył pokój (już tam był)
            const clients = Array.from(room);
            io.sockets.sockets.get(clients[0]).emit('set_role', { isHost: true });
            socket.emit('set_role', { isHost: false });
        } else {
            socket.emit('error_msg', 'Pokój nie istnieje lub jest pełny!');
        }
    });

    // PRZEKAZYWANIE ZDARZEŃ W GRZE (Przekaźnik)
    // Jeśli gracz wyśle akcję, serwer przekazuje ją tylko do drugiego gracza w pokoju
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

    // ROZŁĄCZENIE
    socket.on('disconnect', () => {
        // Usuń z kolejki jeśli tam był
        if (socket.queueRank && queues[socket.queueRank]) {
            queues[socket.queueRank] = queues[socket.queueRank].filter(s => s !== socket);
        }

        // Jeśli był w grze, zamknij grę i poinformuj drugiego gracza
        if (socket.currentRoom) {
            socket.to(socket.currentRoom).emit('opponent_disconnected');
            activeMatches--;
            if (activeMatches < 0) activeMatches = 0;
        }
    });
});

// 4. Wysyłanie statystyk do Supabase co 1 minutę
setInterval(async () => {
    if (supabase && activeMatches > 0) {
        let playersInGame = activeMatches * 2; 
        console.log(`Wysyłam statystyki: ${activeMatches} meczów (${playersInGame} graczy).`);
        
        const { error } = await supabase.from('server_stats').insert([{ active_players: playersInGame }]);
        if (error) console.error('Błąd Supabase:', error.message);
    }
}, 60000);

server.listen(port, () => {
    console.log(`Serwer (Socket.io) działa na porcie ${port}`);
});