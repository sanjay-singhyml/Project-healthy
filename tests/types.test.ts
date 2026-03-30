// Test suite for types and data models
import { describe, it, expect } from "vitest";
import {
  getScoreBand,
  SCORE_BANDS,
  DEFAULT_SCORING_WEIGHTS,
} from "../src/types/index.js";

describe("Types and Data Models", () => {
  describe("getScoreBand", () => {
    it("returns EXCELLENT for 90-100", () => {
      expect(getScoreBand(100)).toBe("EXCELLENT");
      expect(getScoreBand(95)).toBe("EXCELLENT");
      expect(getScoreBand(90)).toBe("EXCELLENT");
    });

    it("returns GOOD for 75-89", () => {
      expect(getScoreBand(89)).toBe("GOOD");
      expect(getScoreBand(80)).toBe("GOOD");
      expect(getScoreBand(75)).toBe("GOOD");
    });

    it("returns MODERATE for 60-74", () => {
      expect(getScoreBand(74)).toBe("MODERATE");
      expect(getScoreBand(67)).toBe("MODERATE");
      expect(getScoreBand(60)).toBe("MODERATE");
    });

    it("returns HIGH_RISK for 40-59", () => {
      expect(getScoreBand(59)).toBe("HIGH_RISK");
      expect(getScoreBand(50)).toBe("HIGH_RISK");
      expect(getScoreBand(40)).toBe("HIGH_RISK");
    });

    it("returns CRITICAL for 0-39", () => {
      expect(getScoreBand(39)).toBe("CRITICAL");
      expect(getScoreBand(20)).toBe("CRITICAL");
      expect(getScoreBand(0)).toBe("CRITICAL");
    });

    it("handles boundary values correctly", () => {
      expect(getScoreBand(100)).toBe("EXCELLENT");
      expect(getScoreBand(90)).toBe("EXCELLENT");
      expect(getScoreBand(89)).toBe("GOOD");
      expect(getScoreBand(75)).toBe("GOOD");
      expect(getScoreBand(74)).toBe("MODERATE");
      expect(getScoreBand(60)).toBe("MODERATE");
      expect(getScoreBand(59)).toBe("HIGH_RISK");
      expect(getScoreBand(40)).toBe("HIGH_RISK");
      expect(getScoreBand(39)).toBe("CRITICAL");
      expect(getScoreBand(0)).toBe("CRITICAL");
    });
  });

  describe("SCORE_BANDS", () => {
    it("defines all 5 bands", () => {
      expect(Object.keys(SCORE_BANDS).length).toBe(5);
      expect(SCORE_BANDS).toHaveProperty("EXCELLENT");
      expect(SCORE_BANDS).toHaveProperty("GOOD");
      expect(SCORE_BANDS).toHaveProperty("MODERATE");
      expect(SCORE_BANDS).toHaveProperty("HIGH_RISK");
      expect(SCORE_BANDS).toHaveProperty("CRITICAL");
    });
  });

  describe("DEFAULT_SCORING_WEIGHTS", () => {
    it("sums to 100", () => {
      const sum = Object.values(DEFAULT_SCORING_WEIGHTS).reduce(
        (a, b) => a + b,
        0,
      );
      expect(sum).toBe(100);
    });

    it("has correct values per PRD", () => {
      expect(DEFAULT_SCORING_WEIGHTS.security).toBe(20);
      expect(DEFAULT_SCORING_WEIGHTS.quality).toBe(18);
      expect(DEFAULT_SCORING_WEIGHTS.cicd).toBe(15);
      expect(DEFAULT_SCORING_WEIGHTS.flakiness).toBe(14);
      expect(DEFAULT_SCORING_WEIGHTS.env).toBe(13);
      expect(DEFAULT_SCORING_WEIGHTS.buildPerf).toBe(10);
      expect(DEFAULT_SCORING_WEIGHTS.docs).toBe(6);
      expect(DEFAULT_SCORING_WEIGHTS.prComplexity).toBe(4);
    });

    it("has 8 modules", () => {
      expect(Object.keys(DEFAULT_SCORING_WEIGHTS).length).toBe(8);
    });
  });
});
