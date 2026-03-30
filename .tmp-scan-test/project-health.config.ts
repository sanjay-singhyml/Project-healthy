import { ProjectHealthConfig } from 'project-health';

export const config: ProjectHealthConfig = {
  "proxy": {
    "url": "https://api.projecthealth.io/v1",
    "timeout": 30000
  },
  "modules": {
    "cicd": {
      "enabled": true,
      "slowJobThresholdMinutes": 5,
      "failureRateThreshold": 20
    },
    "quality": {
      "enabled": true,
      "complexityThreshold": 10,
      "duplicateLineMin": 51
    },
    "docs": {
      "enabled": true,
      "stalenessDays": 14,
      "aiSemanticCheck": false
    },
    "flakiness": {
      "enabled": true,
      "lookbackRuns": 20,
      "passRateThreshold": 95
    },
    "security": {
      "enabled": true,
      "blockedLicenses": [
        "GPL",
        "AGPL",
        "UNLICENSED"
      ]
    },
    "prComplexity": {
      "enabled": true,
      "maxLinesChanged": 500,
      "maxFilesChanged": 5,
      "reviewTimeoutDays": 3
    },
    "env": {
      "enabled": true,
      "secretPatterns": [
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "private_key",
        "aws_access"
      ]
    },
    "buildPerf": {
      "enabled": true,
      "bottleneckThresholdPct": 30,
      "maxBuildTimeMs": 300000
    }
  },
  "scoring": {
    "weights": {
      "security": 20,
      "quality": 18,
      "cicd": 15,
      "flakiness": 14,
      "env": 13,
      "buildPerf": 10,
      "docs": 6,
      "prComplexity": 4
    },
    "failUnder": 60
  },
  "docUpdater": {
    "mode": "pr"
  }
};
