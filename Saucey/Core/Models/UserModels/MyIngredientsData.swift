import Foundation
import FirebaseFirestore

struct MyIngredient: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var location: IngredientLocation
    var quantity: String? // Keep as string for flexibility (e.g., "2 cups", "1 bag", "some")
    var isVerified: Bool // User confirmed this ingredient
    var confidence: Double // AI confidence level (0.0 - 1.0)
    var addedAt: Date
    var category: IngredientCategory // Added to distinguish ingredients from spices
    var isAvailable: Bool // For spices - simple availability toggle
    
    init(id: String = UUID().uuidString, 
         name: String, 
         location: IngredientLocation, 
         quantity: String? = nil, 
         isVerified: Bool = false, 
         confidence: Double = 1.0, 
         addedAt: Date = Date(),
         category: IngredientCategory = .ingredient,
         isAvailable: Bool = true) {
        self.id = id
        self.name = name
        self.location = location
        self.quantity = quantity
        self.isVerified = isVerified
        self.confidence = confidence
        self.addedAt = addedAt
        self.category = category
        self.isAvailable = isAvailable
    }
    
    // Hashable conformance
    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
    
    // Equatable conformance
    static func == (lhs: MyIngredient, rhs: MyIngredient) -> Bool {
        lhs.id == rhs.id
    }
}

enum IngredientCategory: String, Codable, CaseIterable, Identifiable {
    case ingredient = "ingredient"
    case spice = "spice"
    case sauce = "sauce"
    
    var id: String { self.rawValue }
    
    var displayName: String {
        switch self {
        case .ingredient: return "Ingredients"
        case .spice: return "Spice Drawer"
        case .sauce: return "Sauces"
        }
    }
}

enum IngredientLocation: String, Codable, CaseIterable, Identifiable {
    case fridge = "fridge"
    case pantry = "pantry"
    case freezer = "freezer"
    case other = "other"
    
    var id: String { self.rawValue }
    
    var displayName: String {
        switch self {
        case .fridge: return "Fridge"
        case .pantry: return "Pantry"
        case .freezer: return "Freezer"
        case .other: return "Other"
        }
    }
    
    var icon: String {
        switch self {
        case .fridge: return "refrigerator"
        case .pantry: return "cabinet"
        case .freezer: return "snowflake"
        case .other: return "questionmark.circle"
        }
    }
}

// MARK: - Current State Model (Lightweight)
struct MyIngredientsData: Codable {
    var ingredients: [MyIngredient]
    var spices: [MyIngredient]
    var sauces: [MyIngredient]
    var lastUpdated: Timestamp
    
    init(ingredients: [MyIngredient] = [], 
         spices: [MyIngredient] = [],
         sauces: [MyIngredient] = [],
         lastUpdated: Timestamp = Timestamp()) {
        self.ingredients = ingredients
        self.spices = spices
        self.sauces = sauces
        self.lastUpdated = lastUpdated
    }
    
    // MARK: - Helper Methods for Category Management
    func itemsForCategory(_ category: IngredientCategory) -> [MyIngredient] {
        switch category {
        case .ingredient: return ingredients
        case .spice: return spices
        case .sauce: return sauces
        }
    }
    
    mutating func setItemsForCategory(_ category: IngredientCategory, items: [MyIngredient]) {
        switch category {
        case .ingredient: ingredients = items
        case .spice: spices = items
        case .sauce: sauces = items
        }
    }
    
    mutating func addItemToCategory(_ category: IngredientCategory, item: MyIngredient) {
        switch category {
        case .ingredient: ingredients.append(item)
        case .spice: spices.append(item)
        case .sauce: sauces.append(item)
        }
    }
    
    mutating func removeItemFromCategory(_ category: IngredientCategory, itemId: String) {
        switch category {
        case .ingredient: ingredients.removeAll { $0.id == itemId }
        case .spice: spices.removeAll { $0.id == itemId }
        case .sauce: sauces.removeAll { $0.id == itemId }
        }
    }
    
    // Helper methods
    func ingredientsByLocation() -> [IngredientLocation: [MyIngredient]] {
        return Dictionary(grouping: ingredients, by: { $0.location })
    }
    
    func totalCount() -> Int {
        return ingredients.count + spices.count + sauces.count
    }
    
    func verifiedCount() -> Int {
        return ingredients.filter { $0.isVerified }.count + spices.filter { $0.isVerified }.count + sauces.filter { $0.isVerified }.count
    }
}

// MARK: - Historical State Snapshot
struct MyIngredientsSnapshot: Codable, Identifiable {
    let id: String
    var ingredients: [MyIngredient]
    var spices: [MyIngredient]
    var sauces: [MyIngredient]
    var snapshotDate: Timestamp
    var changeReason: String // "analysis_completed", "bulk_update", "manual_edit"
    var totalItemCount: Int
    var previousSnapshotId: String? // Link to previous snapshot for comparison
    
    init(id: String = UUID().uuidString,
         ingredients: [MyIngredient] = [],
         spices: [MyIngredient] = [],
         sauces: [MyIngredient] = [],
         snapshotDate: Timestamp = Timestamp(),
         changeReason: String,
         totalItemCount: Int? = nil,
         previousSnapshotId: String? = nil) {
        self.id = id
        self.ingredients = ingredients
        self.spices = spices
        self.sauces = sauces
        self.snapshotDate = snapshotDate
        self.changeReason = changeReason
        self.totalItemCount = totalItemCount ?? (ingredients.count + spices.count + sauces.count)
        self.previousSnapshotId = previousSnapshotId
    }
    
    // Create snapshot from current data
    static func from(_ data: MyIngredientsData, reason: String, previousSnapshotId: String? = nil) -> MyIngredientsSnapshot {
        return MyIngredientsSnapshot(
            ingredients: data.ingredients,
            spices: data.spices,
            sauces: data.sauces,
            snapshotDate: Timestamp(),
            changeReason: reason,
            totalItemCount: data.totalCount(),
            previousSnapshotId: previousSnapshotId
        )
    }
}

// MARK: - Activity Event Logging
struct IngredientHistoryEvent: Codable, Identifiable {
    let id: String
    let userId: String
    let timestamp: Timestamp
    let action: String // "analysis_started", "analysis_completed", "items_added", "items_removed", "saved"
    let method: String // "image", "text", "manual", "bulk"
    let itemCount: Int
    let category: String? // "ingredient", "spice", "mixed"
    let details: [String: String]? // Additional context
    
    init(id: String = UUID().uuidString,
         userId: String,
         timestamp: Timestamp = Timestamp(),
         action: String,
         method: String,
         itemCount: Int,
         category: String? = nil,
         details: [String: String]? = nil) {
        self.id = id
        self.userId = userId
        self.timestamp = timestamp
        self.action = action
        self.method = method
        self.itemCount = itemCount
        self.category = category
        self.details = details
    }
}

// MARK: - Snapshot Change Reasons
enum SnapshotReason: String, CaseIterable {
    case analysisCompleted = "analysis_completed"
    case bulkUpdate = "bulk_update"
    case majorEdit = "major_edit"
    case manualSnapshot = "manual_snapshot"
    
    var shouldCreateSnapshot: Bool {
        switch self {
        case .analysisCompleted, .bulkUpdate, .majorEdit:
            return true
        case .manualSnapshot:
            return true
        }
    }
}

// MARK: - Legacy Support (for migration)
struct IngredientHistoryEntry: Codable, Identifiable {
    let id: String
    let date: Date
    let analysisType: String // "image" or "text"
    let inputDescription: String // What was analyzed
    let detectedCount: Int
    
    init(id: String = UUID().uuidString,
         date: Date = Date(),
         analysisType: String,
         inputDescription: String,
         detectedCount: Int) {
        self.id = id
        self.date = date
        self.analysisType = analysisType
        self.inputDescription = inputDescription
        self.detectedCount = detectedCount
    }
    
    // Convert to new event format
    func toHistoryEvent(userId: String) -> IngredientHistoryEvent {
        return IngredientHistoryEvent(
            userId: userId,
            timestamp: Timestamp(date: date),
            action: inputDescription,
            method: analysisType,
            itemCount: detectedCount
        )
    }
}

// MARK: - API Response Models
struct IngredientAnalysisResponse: Codable {
    let detectedIngredients: [DetectedIngredient]
    let confidence: Double
    let suggestions: [String]?
    
    struct DetectedIngredient: Codable {
        let name: String
        let quantity: String?
        let confidence: Double
        let location: String
    }
} 