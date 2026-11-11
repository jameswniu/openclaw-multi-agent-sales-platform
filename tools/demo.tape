# Terminal recording for the README. Run from the repo root after the three plugin installs: vhs tools/demo.tape
Output assets/demo.gif
Set Shell "bash"
Set FontFamily "Menlo"
Set FontSize 21
Set Width 1200
Set Height 440
Set Padding 24
Set Framerate 12
Set TypingSpeed 30ms
Set Theme { "name": "graphite", "black": "#0e1117", "red": "#ff5c5c", "green": "#5bbfad", "yellow": "#8b949e", "blue": "#8b949e", "magenta": "#8b949e", "cyan": "#5bbfad", "white": "#e6e9ee", "brightBlack": "#2c333d", "brightRed": "#ff5c5c", "brightGreen": "#5bbfad", "brightYellow": "#8b949e", "brightBlue": "#8b949e", "brightMagenta": "#8b949e", "brightCyan": "#5bbfad", "brightWhite": "#e6e9ee", "background": "#0e1117", "foreground": "#e6e9ee", "selection": "#2c333d", "cursor": "#ff5c5c" }

Hide
Type "export PS1='\[\e[38;2;139;148;158m\]$ \[\e[0m\]' && clear"
Enter
Sleep 400ms
Show

Type "node scripts/demo-guard.mjs"
Enter
Sleep 4s

Hide
Type "clear"
Enter
Sleep 400ms
Show
Type "(cd plugins/user-memory && npx vitest run src/store.test.ts 2>&1 | tail -9)"
Enter
Sleep 6s

Hide
Type "clear"
Enter
Sleep 400ms
Show
Type "python3 tools/facts.py"
Enter
Sleep 5s
