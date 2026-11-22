export const STAGES = {
  B2C: ["new", "contacted", "booked", "won", "lost"],
  B2B: ["lead", "site_visit", "quote", "negotiation", "won", "lost"],
};

const GRAPH = {
  B2C: { new: ["contacted", "lost"], contacted: ["booked", "lost"], booked: ["won", "lost", "contacted"], won: [], lost: [] },
  B2B: {
    lead: ["site_visit", "lost"],
    site_visit: ["quote", "lost"],
    quote: ["negotiation", "won", "lost"],
    negotiation: ["quote", "won", "lost"],
    won: [],
    lost: [],
  },
};

export const initialStage = (type) => STAGES[type][0];
export const isTerminal = (stage) => stage === "won" || stage === "lost";
export const canTransition = (type, from, to) => GRAPH[type]?.[from]?.includes(to) ?? false;
