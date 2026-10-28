import { createYoga, createSchema } from "graphql-yoga";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { useGqlcovCapture } from "@gqlcov/capture-envelop";

const typeDefs = readFileSync(new URL("../schema.graphql", import.meta.url), "utf8");

const clubs = [{ id: "c1", name: "TC Aalst", courts: 8 }];
const players = [
  { id: "p1", name: "Ann", gender: "F", rating: 4.2, clubId: "c1" },
  { id: "p2", name: "Bart", gender: "M", rating: 3.8, clubId: "c1" },
];
const matches: { id: string; surface: string; playerIds: string[]; sets: { games: number; tiebreak?: number | null }[]; note?: string | null }[] = [];

export function createApp(captureDir?: string) {
  const yoga = createYoga({
    schema: createSchema({
      typeDefs,
      resolvers: {
        Query: {
          player: (_: unknown, { id }: { id: string }) => players.find((p) => p.id === id) ?? null,
          players: (_: unknown, { filter, first }: { filter?: { clubId?: string; gender?: string; minRating?: number; nameContains?: string }; first: number }) =>
            players
              .filter((p) => !filter?.clubId || p.clubId === filter.clubId)
              .filter((p) => !filter?.gender || p.gender === filter.gender)
              .filter((p) => filter?.minRating == null || p.rating >= filter.minRating)
              .filter((p) => !filter?.nameContains || p.name.includes(filter.nameContains))
              .slice(0, first),
          match: (_: unknown, { id }: { id: string }) => matches.find((m) => m.id === id) ?? null,
          clubs: () => clubs,
        },
        Mutation: {
          createMatch: (_: unknown, { input }: { input: { surface: string; playerIds: string[]; sets?: { games: number; tiebreak?: number | null }[]; note?: string | null } }) => {
            const m = { id: `m${matches.length + 1}`, surface: input.surface, playerIds: input.playerIds, sets: input.sets ?? [], note: input.note ?? null };
            matches.push(m);
            return m;
          },
          renamePlayer: (_: unknown, { id, name }: { id: string; name: string }) => {
            const p = players.find((x) => x.id === id);
            if (!p) throw new Error("not found");
            p.name = name;
            return p;
          },
        },
        Player: { club: (p: { clubId: string }) => clubs.find((c) => c.id === p.clubId) ?? null },
        Match: { players: (m: { playerIds: string[] }) => m.playerIds.map((id) => players.find((p) => p.id === id)) },
      },
    }),
    plugins: [useGqlcovCapture({ dir: captureDir, enabled: true, source: (ctx) => (ctx.request as Request | undefined)?.headers.get("x-test-name") ?? undefined })],
    logging: false,
  });
  return createServer(yoga);
}

if (process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts")) {
  const port = Number(process.env.PORT ?? 4000);
  createApp().listen(port, () => console.log(`example server on http://localhost:${port}/graphql`));
}
