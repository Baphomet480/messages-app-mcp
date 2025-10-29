#!/usr/bin/env swift

import Foundation

struct IntentContext: Codable {
    let defaultDays: Int
    let maxDays: Int
    let defaultLimit: Int
    let maxLimit: Int
}

struct IntentRequest: Codable {
    let query: String
    let context: IntentContext
    let metadata: [String: String]? = nil
}

struct IntentResult: Codable {
    var query: String?
    var participant: String?
    var chat_guid: String?
    var days_back: Int?
    var limit: Int?
    var confidence: Double?
    var source: String?
}

struct IntentResponse: Codable {
    let result: IntentResult?
    let error: String?
}

func readRequest() throws -> IntentRequest {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    if data.isEmpty {
        throw NSError(domain: "ai-search", code: 1, userInfo: [NSLocalizedDescriptionKey: "Empty stdin"])
    }
    return try JSONDecoder().decode(IntentRequest.self, from: data)
}

let emailRegex = try! NSRegularExpression(pattern: "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", options: [.caseInsensitive])
let phoneRegex = try! NSRegularExpression(pattern: "\\+?[0-9][0-9\\-\\s]{6,}")
let guidRegex = try! NSRegularExpression(pattern: "chat[0-9A-Fa-f]{16,}")

func extractFirstMatch(regex: NSRegularExpression, in text: String) -> String? {
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    if let match = regex.firstMatch(in: text, options: [], range: range) {
        if let swiftRange = Range(match.range, in: text) {
            return String(text[swiftRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
    return nil
}

func heuristicRefinement(request: IntentRequest) -> IntentResult {
    var result = IntentResult()
    result.source = "heuristic"
    result.confidence = 0.35

    let lower = request.query.lowercased()
    if lower.contains("yesterday") {
        result.days_back = max(request.context.defaultDays, 2)
        result.confidence = 0.45
    } else if lower.contains("last week") {
        result.days_back = min(7, request.context.maxDays)
        result.confidence = 0.5
    } else if lower.contains("last month") {
        result.days_back = min(30, request.context.maxDays)
        result.confidence = 0.5
    }

    if lower.contains("limit ") {
        if let limitValue = extractLimit(from: lower) {
            result.limit = min(limitValue, request.context.maxLimit)
            result.confidence = max(result.confidence ?? 0.35, 0.45)
        }
    }

    if let email = extractFirstMatch(regex: emailRegex, in: request.query) {
        result.participant = email
        result.confidence = max(result.confidence ?? 0.35, 0.55)
    }

    if let phone = extractFirstMatch(regex: phoneRegex, in: request.query) {
        let compactPhone = phone.replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "-", with: "")
        result.participant = compactPhone
        result.confidence = max(result.confidence ?? 0.35, 0.45)
    }

    if let guid = extractFirstMatch(regex: guidRegex, in: request.query) {
        result.chat_guid = guid
        result.confidence = max(result.confidence ?? 0.35, 0.4)
    }

    if result.participant == nil && (lower.contains("from ") || lower.contains("with ")) {
        result.participant = guessNameParticipant(from: request.query)
    }

    let refinedQuery = filteredQuery(from: request.query)
    if refinedQuery != request.query {
        result.query = refinedQuery
    }

    return result
}

func extractLimit(from text: String) -> Int? {
    let tokens = text.split(separator: " ")
    for (index, token) in tokens.enumerated() {
        if token == "limit", index + 1 < tokens.count {
            let next = tokens[index + 1]
            if let value = Int(next) {
                return value
            }
        }
    }
    return nil
}

func guessNameParticipant(from text: String) -> String? {
    let words = text.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "'" })
    if let last = words.last, last.count > 1 {
        return String(last)
    }
    return nil
}

func filteredQuery(from text: String) -> String {
    let keywords = ["yesterday", "today", "earlier", "last", "limit"]
    var filtered = text
    for keyword in keywords {
        filtered = filtered.replacingOccurrences(of: keyword, with: "", options: [.caseInsensitive])
    }
    return filtered.trimmingCharacters(in: .whitespacesAndNewlines)
}

func write(response: IntentResponse) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    if let data = try? encoder.encode(response) {
        FileHandle.standardOutput.write(data)
    } else {
        let fallback = "{\"error\":\"encoding_failed\"}"
        FileHandle.standardOutput.write(fallback.data(using: .utf8) ?? Data())
    }
}

let response: IntentResponse

do {
    let request = try readRequest()
    let result = heuristicRefinement(request: request)
    response = IntentResponse(result: result, error: nil)
} catch {
    response = IntentResponse(result: nil, error: error.localizedDescription)
}

write(response)
