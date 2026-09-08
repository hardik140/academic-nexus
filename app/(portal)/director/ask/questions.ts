export const QUESTIONS = [
  { key: "attention_department", label: "Which department needs the most attention?" },
  { key: "attendance_below_target", label: "Which departments are below target on attendance?" },
  { key: "student_risk", label: "How many students are at high risk institution-wide?" },
  { key: "placement_trend", label: "Is placement trending up or down?" },
  { key: "goals_behind", label: "Which strategic goals are behind schedule?" },
  { key: "overspending", label: "Where are we overspending?" },
] as const;
export type QuestionKey = (typeof QUESTIONS)[number]["key"];
