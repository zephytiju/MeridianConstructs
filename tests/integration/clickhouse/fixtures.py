# SPDX-License-Identifier: Apache-2.0
"""Typed OTLP fixtures; all normalized rows are written by the stock Collector."""

import copy

NANO = "1788886500123456789"


def attr(k, t, v):
    return {"key": k, "value": {t: v}}


ATTRS = [
    attr("integer", "intValue", "1"),
    attr("double", "doubleValue", 1.0),
    attr("text", "stringValue", "1"),
    attr("boolean", "boolValue", True),
    attr("boolean_text", "stringValue", "true"),
    attr("bytes", "bytesValue", "AQI="),
    attr("bytes_text", "stringValue", "AQI="),
    attr("large", "intValue", "9007199254740993"),
]
ATTRS += [
    attr("nested", "kvlistValue", {"values": copy.deepcopy(ATTRS)}),
    attr(
        "array",
        "arrayValue",
        {"values": [{"intValue": "1"}, {"stringValue": "1"}, {"boolValue": True}]},
    ),
]
RESOURCE = {"attributes": [attr("service.name", "stringValue", "stock-context-probe")]}
SCOPE = {"name": "fidelity-fixture", "version": "1.0"}
TRACE = {
    "traceId": "1234567890abcdef1234567890abcdef",
    "spanId": "1234567890abcdef",
    "name": "linked",
    "kind": 1,
    "startTimeUnixNano": NANO,
    "endTimeUnixNano": str(int(NANO) + 7),
    "attributes": ATTRS,
    "events": [{"name": "typed-event", "timeUnixNano": str(int(NANO) + 1), "attributes": ATTRS}],
    "links": [
        {
            "traceId": "abcdef1234567890abcdef1234567890",
            "spanId": "abcdef1234567890",
            "traceState": "vendor=abc",
            "flags": 257,
            "attributes": ATTRS,
            "droppedAttributesCount": 2,
        }
    ],
}
EXEMPLAR = {
    "timeUnixNano": str(int(NANO) + 1),
    "asInt": "9007199254740993",
    "traceId": TRACE["traceId"],
    "spanId": TRACE["spanId"],
    "filteredAttributes": ATTRS,
}
POINTS = [
    {
        "timeUnixNano": NANO,
        "startTimeUnixNano": str(int(NANO) - 1),
        kind: value,
        "attributes": [attr("case", "stringValue", name), *ATTRS],
        "exemplars": [EXEMPLAR],
    }
    for name, kind, value in [
        ("large_a", "asInt", "9007199254740992"),
        ("large_b", "asInt", "9007199254740993"),
        ("int_zero", "asInt", "0"),
        ("double_zero", "asDouble", 0.0),
    ]
]
HIST = {
    "timeUnixNano": NANO,
    "startTimeUnixNano": str(int(NANO) - 1),
    "count": "3",
    "sum": 4.5,
    "min": 0.25,
    "max": 3.0,
    "bucketCounts": ["1", "1", "1"],
    "explicitBounds": [1.0, 2.0],
    "exemplars": [EXEMPLAR],
    "attributes": ATTRS,
}
PAYLOADS = {
    "traces": {
        "resourceSpans": [
            {"resource": RESOURCE, "scopeSpans": [{"scope": SCOPE, "spans": [TRACE]}]}
        ]
    },
    "metrics": {
        "resourceMetrics": [
            {
                "resource": RESOURCE,
                "scopeMetrics": [
                    {
                        "scope": SCOPE,
                        "metrics": [{"name": "numbers", "gauge": {"dataPoints": POINTS}}],
                    }
                ],
            }
        ]
    },
    "histograms": {
        "resourceMetrics": [
            {
                "resource": RESOURCE,
                "scopeMetrics": [
                    {
                        "scope": SCOPE,
                        "metrics": [
                            {
                                "name": "histogram",
                                "histogram": {"aggregationTemporality": 2, "dataPoints": [HIST]},
                            }
                        ],
                    }
                ],
            }
        ]
    },
    "logs": {
        "resourceLogs": [
            {
                "resource": RESOURCE,
                "scopeLogs": [
                    {
                        "scope": SCOPE,
                        "logRecords": [
                            {
                                "timeUnixNano": NANO,
                                "observedTimeUnixNano": str(int(NANO) + 1),
                                "attributes": ATTRS,
                                "body": {"kvlistValue": {"values": ATTRS}},
                            }
                        ],
                    }
                ],
            }
        ]
    },
}

EXPONENTIAL = {
    "timeUnixNano": NANO,
    "startTimeUnixNano": str(int(NANO) - 1),
    "count": "4",
    "sum": 1.0,
    "min": -0.25,
    "max": 0.5,
    "scale": 2,
    "zeroCount": "1",
    "zeroThreshold": 0.01,
    "positive": {"offset": -1, "bucketCounts": ["1", "1"]},
    "negative": {"offset": 0, "bucketCounts": ["1"]},
    "exemplars": [EXEMPLAR],
    "attributes": ATTRS,
}
PAYLOADS["additional"] = {
    "resourceMetrics": [
        {
            "resource": RESOURCE,
            "scopeMetrics": [
                {
                    "scope": SCOPE,
                    "metrics": [
                        {
                            "name": "exponential",
                            "exponentialHistogram": {
                                "aggregationTemporality": 2,
                                "dataPoints": [EXPONENTIAL],
                            },
                        },
                        {
                            "name": "float.edges",
                            "metadata": [
                                attr("z", "stringValue", "last"),
                                attr("a", "intValue", "1"),
                            ],
                            "gauge": {
                                "dataPoints": [
                                    {
                                        "timeUnixNano": NANO,
                                        "asDouble": v,
                                        "attributes": [attr("case", "stringValue", k)],
                                    }
                                    for k, v in [
                                        ("negative-zero", -0.0),
                                        ("subnormal", 5e-324),
                                        ("large-float", 1e20),
                                    ]
                                ]
                            },
                        },
                    ],
                }
            ],
        }
    ]
}
