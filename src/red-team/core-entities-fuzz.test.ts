import { describe, expect, it } from "vitest";
import { MemoryCache } from "../cache/memory-cache";
import { Client } from "../core";
import { entities } from "../entities";

/**
 * Waits.
 */
function wait(ms: number): Promise<void> {
	return new Promise(function later(resolve) {
		setTimeout(resolve, ms);
	});
}

/**
 * Test helper.
 */
function rng(seed: number) {
	let s = seed >>> 0;
	return function next(): number {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/**
 * Builds a random entity tree.
 */
function randomEntity(r: () => number, depth: number): unknown {
	const ids = ["1", "2", 1];
	const o: Record<string, unknown> = { __typename: r() < 0.8 ? "User" : "Team", id: ids[Math.floor(r() * ids.length)] };
	if (r() < 0.7) o.name = ["a", "b", "c"][Math.floor(r() * 3)];
	if (r() < 0.4) o.tags = r() < 0.5 ? ["x"] : ["y", "z"];
	if (r() < 0.3) o.name = { nested: true };
	if (depth > 0 && r() < 0.5) o.friend = randomEntity(r, depth - 1);
	if (depth > 0 && r() < 0.3) o.friends = [randomEntity(r, depth - 1), randomEntity(r, depth - 1)];
	return o;
}

describe("entities() propagation terminates", function () {
	it("bounded writes on random entries", async function () {
		for (let seed = 1; seed <= 150; seed++) {
			const r = rng(seed);
			const client = new Client({
				url: "https://x/graphql",
				cache: new MemoryCache({ maxSize: 1000 }),
				plugins: [entities()],
			});
			let writes = 0;
			const log: string[] = [];
			client.on("cache", function count(ev) {
				writes++;
				if (writes < 40) log.push(JSON.stringify(ev.key) + " " + JSON.stringify(ev.data));
				if (writes === 500) client.dispose();
			});
			for (let i = 0; i < 6; i++) {
				await client.write(
					{ key: [`k${Math.floor(r() * 4)}`], query: "query Q { q }" },
					{ q: [randomEntity(r, 2), randomEntity(r, 2)] },
				);
			}
			await wait(30);
			const before = writes;
			await wait(30);
			if (writes !== before || writes > 200)
				throw new Error(`seed ${seed}: ${writes} writes (still growing: ${writes !== before})\n` + log.join("\n"));
		}
		expect(true).toBe(true);
	}, 60_000);
});
