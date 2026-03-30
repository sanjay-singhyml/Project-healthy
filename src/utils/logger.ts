import debug from "debug";

export const loggers = {
  "ph:cli": debug("ph:cli"),
  "ph:security": debug("ph:security"),
  "ph:quality": debug("ph:quality"),
  "ph:flakiness": debug("ph:flakiness"),
  "ph:cicd": debug("ph:cicd"),
  "ph:env": debug("ph:env"),
  "ph:buildperf": debug("ph:buildperf"),
  "ph:ask": debug("ph:ask"),
  "ph:cache": debug("ph:cache"),
  "ph:explore": debug("ph:explore"),
  "ph:dashboard": debug("ph:dashboard"),
  "ph:context": debug("ph:context"),
  "ph:docs": debug("ph:docs"),
  "ph:prcomplexity": debug("ph:prcomplexity"),
  "ph:fix": debug("ph:fix"),
};

export type LogNamespace = keyof typeof loggers;

export function createLogger(namespace: LogNamespace) {
  return loggers[namespace];
}
