const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Load questions
const questions = JSON.parse(fs.readFileSync('questions.json', 'utf8'));

// Game state
const TEAM_NAMES = ['Team 1', 'Team 2', 'Team 3', 'Team 4', 'Team 5', 'Team 6'];
const TEAM_COLORS = ['#e21b3c', '#1368ce', '#d89e00', '#26890c', '#9b59b6', '#e67e22'];
const TIME_LIMIT = 60;

let game = resetGame();

function resetGame() {
  return {
    state: 'lobby',       // lobby | question | results | final
    currentQ: -1,
    scores: [0, 0, 0, 0, 0, 0],
    teamAnswers: {},       // { visitorId: { team, answer } }
    teamPlayers: {},       // { visitorId: { team, name } }
    teamLockedIn: [false, false, false, false, false, false],
    timer: null,
    timeLeft: TIME_LIMIT,
  };
}

// Get local IP for QR code
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

app.use(express.static('public'));

// QR code endpoint
app.get('/api/qrcode', async (req, res) => {
  // Use the request's host header for the URL (works for both local and deployed)
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${protocol}://${host}/play.html`;
  const qr = await QRCode.toDataURL(url, { width: 300, margin: 2 });
  res.json({ qr, url });
});

app.get('/api/state', (req, res) => {
  res.json({ state: game.state });
});

// Socket.IO
io.on('connection', (socket) => {
  // Host connects
  socket.on('host:join', () => {
    socket.join('host');
    socket.emit('game:state', getHostState());
  });

  // Player connects
  socket.on('player:join', ({ name, team, visitorId }) => {
    if (game.state !== 'lobby' && !game.teamPlayers[visitorId]) {
      socket.emit('player:error', 'Game already in progress. Wait for next round.');
      return;
    }
    game.teamPlayers[visitorId] = { team, name, socketId: socket.id };
    socket.join('players');
    socket.visitorId = visitorId;

    socket.emit('player:joined', { team, name });
    io.to('host').emit('lobby:update', getLobbyData());

    // If game is in progress, send current state to reconnecting player
    if (game.state === 'question') {
      const q = questions[game.currentQ];
      socket.emit('player:question', {
        index: game.currentQ + 1,
        total: questions.length,
        question: q.question,
        answers: q.answers,
        timeLeft: game.timeLeft,
      });
      // Restore their previous answer if any
      if (game.teamAnswers[visitorId] !== undefined) {
        socket.emit('player:alreadyAnswered');
      }
    } else if (game.state === 'results') {
      socket.emit('player:wait', 'Waiting for next question...');
    } else if (game.state === 'final') {
      socket.emit('player:final', getFinalData());
    }
  });

  // Player submits answer
  socket.on('player:answer', ({ visitorId, answer }) => {
    if (game.state !== 'question') return;
    const player = game.teamPlayers[visitorId];
    if (!player) return;

    game.teamAnswers[visitorId] = { team: player.team, answer };
    socket.emit('player:alreadyAnswered');

    // Check if all players in a team have answered - use majority vote
    updateTeamStatus();
    io.to('host').emit('game:state', getHostState());
  });

  // Host starts game
  socket.on('host:start', () => {
    if (game.state !== 'lobby') return;
    nextQuestion();
  });

  // Host moves to next question
  socket.on('host:next', () => {
    if (game.state !== 'results') return;
    if (game.currentQ >= questions.length - 1) {
      showFinal();
    } else {
      nextQuestion();
    }
  });

  // Host forces submit (time's up handled server-side)
  socket.on('host:forceSubmit', () => {
    if (game.state !== 'question') return;
    endQuestion();
  });

  // Host restarts
  socket.on('host:restart', () => {
    game = resetGame();
    io.to('host').emit('game:state', getHostState());
    io.to('players').emit('player:restart');
  });

  socket.on('disconnect', () => {
    // Keep player data for reconnection via visitorId
  });
});

function nextQuestion() {
  game.currentQ++;
  game.state = 'question';
  game.teamAnswers = {};
  game.teamLockedIn = [false, false, false, false, false, false];
  game.timeLeft = TIME_LIMIT;

  const q = questions[game.currentQ];
  const questionData = {
    index: game.currentQ + 1,
    total: questions.length,
    question: q.question,
    answers: q.answers,
    timeLeft: TIME_LIMIT,
  };

  io.to('host').emit('game:state', getHostState());
  io.to('players').emit('player:question', questionData);

  // Start timer
  clearInterval(game.timer);
  game.timer = setInterval(() => {
    game.timeLeft--;
    io.to('host').emit('timer:tick', game.timeLeft);
    io.to('players').emit('timer:tick', game.timeLeft);
    if (game.timeLeft <= 0) {
      clearInterval(game.timer);
      endQuestion();
    }
  }, 1000);
}

function updateTeamStatus() {
  // For each team, check if at least one player answered
  for (let t = 0; t < 6; t++) {
    const teamPlayerIds = Object.keys(game.teamPlayers).filter(
      id => game.teamPlayers[id].team === t
    );
    if (teamPlayerIds.length === 0) continue;
    const answered = teamPlayerIds.filter(id => game.teamAnswers[id] !== undefined);
    game.teamLockedIn[t] = answered.length === teamPlayerIds.length;
  }

  // Auto-end if all teams with players are locked in
  const teamsWithPlayers = [];
  for (let t = 0; t < 6; t++) {
    const count = Object.values(game.teamPlayers).filter(p => p.team === t).length;
    if (count > 0) teamsWithPlayers.push(t);
  }
  if (teamsWithPlayers.length > 0 && teamsWithPlayers.every(t => game.teamLockedIn[t])) {
    clearInterval(game.timer);
    setTimeout(() => endQuestion(), 500); // brief delay
  }
}

function endQuestion() {
  clearInterval(game.timer);
  game.state = 'results';

  const q = questions[game.currentQ];
  const correct = q.correct;

  // Determine each team's answer by majority vote
  const teamFinalAnswers = [];
  for (let t = 0; t < 6; t++) {
    const votes = {};
    Object.entries(game.teamAnswers).forEach(([vid, data]) => {
      if (data.team === t) {
        votes[data.answer] = (votes[data.answer] || 0) + 1;
      }
    });

    let bestAnswer = -1;
    let bestCount = 0;
    Object.entries(votes).forEach(([ans, count]) => {
      if (count > bestCount) {
        bestCount = count;
        bestAnswer = parseInt(ans);
      }
    });

    const isCorrect = bestAnswer === correct;
    if (isCorrect) game.scores[t] += 100;

    const playerCount = Object.values(game.teamPlayers).filter(p => p.team === t).length;
    teamFinalAnswers.push({
      team: t,
      name: TEAM_NAMES[t],
      color: TEAM_COLORS[t],
      answer: bestAnswer,
      answerText: bestAnswer >= 0 ? q.answers[bestAnswer] : 'No answer',
      isCorrect,
      score: game.scores[t],
      playerCount,
    });
  }

  const resultsData = {
    question: q.question,
    correctIndex: correct,
    correctText: q.answers[correct],
    teams: teamFinalAnswers,
    isLast: game.currentQ >= questions.length - 1,
  };

  io.to('host').emit('game:results', resultsData);
  io.to('players').emit('player:results', resultsData);
}

function showFinal() {
  game.state = 'final';
  const data = getFinalData();
  io.to('host').emit('game:final', data);
  io.to('players').emit('player:final', data);
}

function getFinalData() {
  const ranked = TEAM_NAMES.map((name, i) => ({
    name,
    score: game.scores[i],
    color: TEAM_COLORS[i],
    playerCount: Object.values(game.teamPlayers).filter(p => p.team === i).length,
  }))
  .filter(t => t.playerCount > 0)
  .sort((a, b) => b.score - a.score);

  return { ranked };
}

function getLobbyData() {
  const teams = TEAM_NAMES.map((name, i) => {
    const players = Object.values(game.teamPlayers)
      .filter(p => p.team === i)
      .map(p => p.name);
    return { name, color: TEAM_COLORS[i], players };
  });
  return { teams };
}

function getHostState() {
  return {
    state: game.state,
    currentQ: game.currentQ,
    total: questions.length,
    scores: game.scores,
    teamLockedIn: game.teamLockedIn,
    timeLeft: game.timeLeft,
    lobby: getLobbyData(),
    question: game.currentQ >= 0 ? {
      question: questions[game.currentQ].question,
      answers: questions[game.currentQ].answers,
    } : null,
  };
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Quiz Battle Server running on port ${PORT}!\n`);
  console.log(`  Host screen:   http://localhost:${PORT}/`);
  console.log(`  Player join:   http://localhost:${PORT}/play.html\n`);
});
