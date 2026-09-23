# Ludo Web

The classic board game Ludo in your browser. Play against the computer, or with friends on the same device.

No installs, no build step, no dependencies. Just HTML, CSS and vanilla JavaScript.

## Features

- **Play vs Computer**: 1 to 3 computer opponents that capture, escape danger and race home
- **Play with Friends**: 2 to 4 players taking turns on one device (pass and play)
- **Mix and match**: each color can be a player, a computer or empty
- **Auto-roll** switch: the dice rolls itself on your turn, and you only pick which token to move
- Animated dice and token moves, with sound effects you can mute
- Works on desktop and mobile, in light and dark mode
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

## Project structure

```
index.html      page markup: setup screen, board, winner dialog
style.css       layout, board, tokens, dice and animations
js/engine.js    game rules, board geometry and computer player (no DOM code)
js/ui.js        board rendering, turn flow, input and sound
```

## License

MIT
