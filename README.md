# Zylo's Zap

A space-themed slot game that runs in the browser, built with plain HTML, CSS, and JavaScript. No frameworks, no game engine.

**Play it here:** https://mmcgrath-dev.github.io/zylos-slot/

## What it is

5 reels, 3 rows, 25 paylines. You play alongside Zylo, a little alien in a UFO who flies around the screen, talks trash in speech bubbles, and every so often zaps symbols into wilds to help you out.

On top of the base game there are two bonus features:

- **Free Spins.** Land 3 or more scatters and Zylo flies you to a green planet through a warp sequence. You get 4 to 8 free spins depending on how many scatters hit, then a total-won screen before heading back.
- **Jackpot (Hold & Win).** Land 3 or more jackpot symbols, or get lucky on a small random chance, and you travel to the jackpot planet. Meteors land on a 5x3 board and stick. Every new meteor resets your spins back to 3. Fill the whole board and you win the grand prize.

There's also a jackpot meter planet that cracks and glows as it fills up, turbo mode, autoplay, a paytable that shows real dollar wins at your current bet, and a hidden dev panel (Ctrl + Shift + D) I used for testing features without waiting for them to hit naturally.

## The part I'm proudest of: fixing the math

A slot game is only as good as its math, and mine was broken. I built a simulator that plays a million spins and measures the RTP (return to player, basically how much of every dollar bet comes back to the player over time). Real slots sit around 92 to 96%.

My first simulator said the game was paying out over 3000%. That turned out to be wrong too. It didn't match how the live game actually worked, so I rebuilt it to mirror the live code exactly. The real number was around 4800%, meaning the game was handing out way more than people bet.

To fix it I:

- Found that the symbol weights were keyed to old symbol names, so all five high-value symbols were silently getting the same weight
- Removed a two-of-a-kind payout rule that pointed at symbols that didn't exist anymore
- Changed bets to split across the 25 paylines and made wins round to cents instead of whole dollars
- Rebuilt the paytable and tuned the free spins and jackpot trigger rates

After that, multiple million-spin runs landed at about **95.6% RTP** with roughly a 32% hit rate. The simulator is in the `Simulator` folder.

## Other stuff worth looking at

- **Reel engine.** The reels speed up, spin, slow down, and bounce using the Web Animations API. The outcome is decided before the reels move, and the anticipation effect (reels that keep spinning longer with a glow) only plays when a bonus is actually about to land. It never fakes it.
- **Nebula background.** `nebula.js` generates a nebula procedurally with noise on a canvas once at load, then lets CSS handle the movement so it doesn't cost anything per frame. It shows up every few minutes in one of three color schemes and drifts across the screen on a random path.
- **Free spins intro.** The travel sequence (screen shake, warp stars, the planet growing in) is drawn on a canvas with requestAnimationFrame.

## Built with

HTML, CSS, vanilla JavaScript, Canvas, and the Web Animations API. I'm self-taught and used AI tools as a coding partner while building this, then tested and debugged everything myself in the browser.

## Running it locally

Download or clone the repo and open `index.html` with a local server. I use the Live Server extension in VS Code.
