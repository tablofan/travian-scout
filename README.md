# TS32 Alliance Scout

A filterable list of the players, villages and oases of IMX, IMXx and NBD on ts32.x3. Open it at <https://tablofan.github.io/travian-scout/>.

Scouted ticks are shared. They live in a small Cloudflare Worker with a Durable Object (`worker/`), so anyone with the link sees and changes the same ticks, live. Deploy it with `cd worker && npx wrangler deploy`.

The A, B and C buttons open the game's rally point with Minerva's picked village, the target and that many scouts filled in. They send nothing on their own.
