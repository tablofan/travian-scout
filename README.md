# TS32 Alliance Scout

A filterable list of the players, villages and oases of IMX, IMXx and NBD on ts32.x3. Open it at <https://tablofan.github.io/travian-scout/>.

Scouted ticks are shared. They live in a small Cloudflare Worker with a Durable Object (`worker/`), so anyone with the link sees and changes the same ticks, live. Deploy it with `cd worker && npx wrangler deploy`.

A, B and C pick a target and how many scouts it gets. On a player's row they pick each of their oases not ticked yet. Send ticks the picked targets and opens one game tab that sends to each, one at a time.

Sending needs the userscript `travian-scout.user.js`, in the browser of whoever sits Minerva:

1. Install Tampermonkey or Violentmonkey.
2. Open <https://tablofan.github.io/travian-scout/travian-scout.user.js> and install it.
3. Reload the scout page. The box under the map says "Userscript 1.0 is on."

The script presses Send, then Confirm, for each target. It tries Minerva's villages 22 down to 06, then 99a, and moves on when one has too few scouts home. It only takes jobs from links opened by this page. It stops, sending nothing, when a confirm page would send anything but that many scouts from that village to that target.
