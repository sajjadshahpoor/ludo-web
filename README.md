# Ludo Web

The classic board game Ludo in your browser. Play against the computer, with friends on the same device, or online with friends anywhere using a room code.

No installs and no build step. Just HTML, CSS and vanilla JavaScript, with Firebase for online rooms.

## Features

- **Play vs Computer**: 1 to 3 computer opponents that capture, escape danger and race home
- **Play with Friends**: 2 to 4 players taking turns on one device (pass and play)
- **Play Online**: create a room, share the link or 5-letter code, and friends join from their own phones. Empty seats can be filled with computer players, players can rejoin after a reload, and the computer takes over if someone leaves
- **Mix and match**: each color can be a player, a computer or empty
- **Auto-roll** switch: the dice rolls itself on your turn, and you only pick which token to move
- **Move preview**: see where each token will land before you choose, with a ⚔️ on moves that capture. Tap the marker to move
- **Resume**: games on one device are saved as you play, so a reload or closed tab doesn't lose them
- **Emoji reactions** in online games: 👍 😂 😮 😡 🎉 👋 pop up over your corner on everyone's screen
- **Voice chat** in online games: tap 🎤 to talk and 🔊 to mute friends. Chips show who has their mic on and glow while they talk. Audio goes straight between players' browsers (WebRTC), so it's free
- Confetti when someone wins
- Animated dice and token moves, with sound effects you can mute
- Works on desktop and mobile, in light and dark mode. On phones the game fits one screen with no scrolling
- Keyboard shortcuts: `Space` rolls, `1`–`4` pick a token

## Rules

- Roll a **6** to bring a token out of the yard.
- Move all four tokens around the board and up your home column to win.
- Landing on an opponent sends that token back to its yard. Start squares and ★ squares are safe.
- Rolling a 6, capturing a token or bringing a token home earns another roll.
- Three 6s in a row ends your turn.
- You need the exact number to reach home.

## Run locally

Clone the repo and open `index.html` in a browser:

```bash
git clone https://github.com/sajjadshahpoor/ludo-web.git
cd ludo-web
open index.html        # macOS; or just double-click the file
```

Or serve it:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Online play setup

Online rooms use a free [Firebase](https://firebase.google.com) project (Spark plan, no billing).

1. Create a project in the [Firebase console](https://console.firebase.google.com).
2. **Authentication → Sign-in method**: enable **Anonymous**.
3. **Realtime Database → Create database**, then paste [`database.rules.json`](database.rules.json) into the **Rules** tab and publish.
4. **Project settings → Your apps → Web**: register an app and copy its config into [`js/firebase-config.js`](js/firebase-config.js).

The config values identify the project and are safe to commit; the database rules control who can read and write.

### How it works

Each roll and move is written to the room as a small action (`{ t: 'roll', v: 4 }`, `{ t: 'move', k: 2 }`). Every device applies the same actions, in the same order, through the same game engine, so all boards stay identical. The player whose turn it is sends the action, and the host also sends the actions for computer seats. Someone who joins late or reloads replays the room's action list to catch up.

Voice chat connects each pair of players directly with WebRTC, using Google's free STUN servers to find a route. Firebase only carries the few setup messages, written under each player's own entry so no extra database rules are needed. Some strict networks (certain mobile carriers or office Wi-Fi) block direct connections; the player chip shows ⚠️ when voice can't connect.

## Project structure

```
index.html            page markup: setup screen, online lobby, board, winner dialog
style.css             layout, board, tokens, dice and animations
js/engine.js          game rules, board geometry and computer player (no DOM code)
js/ui.js              board rendering, turn flow, input and sound
js/online.js          online rooms: create/join, lobby, syncing actions via Firebase
js/voice.js           voice chat between players (WebRTC, set up through Firebase)
js/firebase-config.js Firebase web app settings
database.rules.json   Realtime Database security rules
```

## Author

Developed by [**Sajjad SHAHPOOR**](https://sajjadshahpoor.github.io/developer/).

## License

MIT
