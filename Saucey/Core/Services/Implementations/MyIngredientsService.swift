import Foundation
import FirebaseFirestore
import FirebaseFunctions
import UIKit

protocol MyIngredientsServiceProtocol {
    func getUserIngredients(userId: String) async throws -> MyIngredientsData?
    func updateUserIngredients(userId: String, ingredients: MyIngredientsData, reason: String) async throws
    func analyzeImage(_ image: UIImage, location: IngredientLocation, hasAnnotation: Bool) async throws -> IngredientAnalysisResponse
    func analyzeText(_ text: String, location: IngredientLocation) async throws -> IngredientAnalysisResponse
    
    // New historization methods
    func createSnapshot(userId: String, data: MyIngredientsData, reason: String, previousSnapshotId: String?) async throws -> String
    func getSnapshots(userId: String, limit: Int) async throws -> [MyIngredientsSnapshot]
    func logHistoryEvent(userId: String, event: IngredientHistoryEvent) async throws
    func getHistoryEvents(userId: String, limit: Int) async throws -> [IngredientHistoryEvent]
}

class MyIngredientsService: MyIngredientsServiceProtocol {
    private let db = Firestore.firestore()
    private let functions = Functions.functions()
    
    func getUserIngredients(userId: String) async throws -> MyIngredientsData? {
        let docRef = db.collection("users").document(userId).collection("ingredients").document("current")
        
        do {
            let document = try await docRef.getDocument()
            
            if document.exists {
                return try document.data(as: MyIngredientsData.self)
            } else {
                // Document doesn't exist, create an empty one and return it
                let emptyData = MyIngredientsData()
                try await updateUserIngredients(userId: userId, ingredients: emptyData, reason: "initialization")
                return emptyData
            }
        } catch {
            print("MyIngredientsService ERROR: Failed to fetch ingredients for user \(userId): \(error.localizedDescription)")
            
            // If permissions error, try to create the document first
            if error.localizedDescription.contains("Missing or insufficient permissions") {
                print("MyIngredientsService: Attempting to create empty ingredients document for user \(userId)")
                let emptyData = MyIngredientsData()
                do {
                    try await updateUserIngredients(userId: userId, ingredients: emptyData, reason: "initialization")
                    return emptyData
                } catch {
                    print("MyIngredientsService ERROR: Failed to create empty document: \(error.localizedDescription)")
                    throw error
                }
            }
            
            throw error
        }
    }
    
    func updateUserIngredients(userId: String, ingredients: MyIngredientsData, reason: String) async throws {
        let docRef = db.collection("users").document(userId).collection("ingredients").document("current")
        
        do {
            // 1. Save current state
            try docRef.setData(from: ingredients)
            print("MyIngredientsService: Successfully updated current ingredients for user \(userId)")
            
            // 2. Create snapshot if reason warrants it
            let snapshotReason = SnapshotReason(rawValue: reason)
            if snapshotReason?.shouldCreateSnapshot == true || shouldCreateSnapshotForReason(reason) {
                let previousSnapshotId = try await getLatestSnapshotId(userId: userId)
                let snapshotId = try await createSnapshot(
                    userId: userId, 
                    data: ingredients, 
                    reason: reason,
                    previousSnapshotId: previousSnapshotId
                )
                print("MyIngredientsService: Created snapshot \(snapshotId) for reason: \(reason)")
            }
            
            // 3. Log activity event
            let event = IngredientHistoryEvent(
                userId: userId,
                action: "saved",
                method: reason.contains("analysis") ? "analysis" : "manual",
                itemCount: ingredients.totalCount(),
                category: "mixed",
                details: ["reason": reason]
            )
            try await logHistoryEvent(userId: userId, event: event)
            
        } catch {
            print("MyIngredientsService ERROR: Failed to update ingredients for user \(userId): \(error.localizedDescription)")
            throw error
        }
    }
    
    // MARK: - Snapshot Management
    func createSnapshot(userId: String, data: MyIngredientsData, reason: String, previousSnapshotId: String? = nil) async throws -> String {
        let snapshot = MyIngredientsSnapshot.from(data, reason: reason, previousSnapshotId: previousSnapshotId)
        let docRef = db.collection("users").document(userId).collection("ingredientSnapshots").document(snapshot.id)
        
        try docRef.setData(from: snapshot)
        print("MyIngredientsService: Created snapshot \(snapshot.id) with \(snapshot.totalItemCount) items")
        return snapshot.id
    }
    
    func getSnapshots(userId: String, limit: Int = 10) async throws -> [MyIngredientsSnapshot] {
        let query = db.collection("users").document(userId)
            .collection("ingredientSnapshots")
            .order(by: "snapshotDate", descending: true)
            .limit(to: limit)
        
        let snapshot = try await query.getDocuments()
        return snapshot.documents.compactMap { try? $0.data(as: MyIngredientsSnapshot.self) }
    }
    
    private func getLatestSnapshotId(userId: String) async throws -> String? {
        let snapshots = try await getSnapshots(userId: userId, limit: 1)
        return snapshots.first?.id
    }
    
    // MARK: - Activity Event Logging
    func logHistoryEvent(userId: String, event: IngredientHistoryEvent) async throws {
        let docRef = db.collection("users").document(userId).collection("ingredientHistory").document(event.id)
        try docRef.setData(from: event)
        print("MyIngredientsService: Logged history event \(event.action) for user \(userId)")
    }
    
    func getHistoryEvents(userId: String, limit: Int = 50) async throws -> [IngredientHistoryEvent] {
        let query = db.collection("users").document(userId)
            .collection("ingredientHistory")
            .order(by: "timestamp", descending: true)
            .limit(to: limit)
        
        let snapshot = try await query.getDocuments()
        return snapshot.documents.compactMap { try? $0.data(as: IngredientHistoryEvent.self) }
    }
    
    // MARK: - Helper Methods
    private func shouldCreateSnapshotForReason(_ reason: String) -> Bool {
        let snapshotTriggers = [
            "analysis_completed",
            "bulk_update", 
            "major_edit",
            "verify_all",
            "manual_snapshot"
        ]
        return snapshotTriggers.contains { reason.contains($0) }
    }
    
    func analyzeImage(_ image: UIImage, location: IngredientLocation, hasAnnotation: Bool = false) async throws -> IngredientAnalysisResponse {
        // Use simple image processing - let backend handle validation (following working pattern)
        guard let imageData = simpleImageProcessing(image) else {
            throw MyIngredientsError.imageCompressionFailed
        }
        
        let base64String = imageData.base64EncodedString()
        
        print("MyIngredientsService: Sending image analysis - Size: \(imageData.count) bytes, Base64 length: \(base64String.count)")
        
        let requestData: [String: Any] = [
            "imageDataBase64": base64String,
            "imageMimeType": "image/jpeg", // Backend will validate this
            "location": location.rawValue,
            "hasAnnotation": hasAnnotation
        ]
        
        do {
            let result = try await functions.httpsCallable("analyzeMyIngredients").call(requestData)
            
            guard let data = result.data as? [String: Any] else {
                throw MyIngredientsError.invalidResponse
            }
            
            let jsonData = try JSONSerialization.data(withJSONObject: data)
            let response = try JSONDecoder().decode(IngredientAnalysisResponse.self, from: jsonData)
            
            return response
        } catch {
            print("MyIngredientsService ERROR: Image analysis failed: \(error.localizedDescription)")
            // Additional error details for Firebase Functions errors
            print("MyIngredientsService ERROR: Full error details: \(error)")
            throw MyIngredientsError.analysisError(error.localizedDescription)
        }
    }
    
    func analyzeText(_ text: String, location: IngredientLocation) async throws -> IngredientAnalysisResponse {
        let requestData: [String: Any] = [
            "text": text,
            "location": location.rawValue
        ]
        
        do {
            let result = try await functions.httpsCallable("analyzeMyIngredientsText").call(requestData)
            
            guard let data = result.data as? [String: Any] else {
                throw MyIngredientsError.invalidResponse
            }
            
            let jsonData = try JSONSerialization.data(withJSONObject: data)
            let response = try JSONDecoder().decode(IngredientAnalysisResponse.self, from: jsonData)
            
            return response
        } catch {
            print("MyIngredientsService ERROR: Text analysis failed: \(error.localizedDescription)")
            throw MyIngredientsError.analysisError(error.localizedDescription)
        }
    }
    
    // MARK: - Image Processing
    private func simpleImageProcessing(_ image: UIImage) -> Data? {
        // Simple processing following the working handleRecipeChatTurn pattern
        // Let the backend (shared image processor) handle size validation
        
        // Basic validation
        guard image.size.width > 0, image.size.height > 0 else {
            print("MyIngredientsService ERROR: Invalid image dimensions")
            return nil
        }
        
        // Use moderate compression quality - backend will validate size
        guard let jpegData = image.jpegData(compressionQuality: 0.8) else {
            print("MyIngredientsService ERROR: Failed to convert image to JPEG")
            return nil
        }
        
        print("MyIngredientsService: Generated JPEG data: \(jpegData.count) bytes")
        return jpegData
    }
}

// MARK: - Custom Errors
enum MyIngredientsError: LocalizedError {
    case imageCompressionFailed
    case invalidResponse
    case analysisError(String)
    
    var errorDescription: String? {
        switch self {
        case .imageCompressionFailed:
            return "Failed to compress image for upload"
        case .invalidResponse:
            return "Invalid response from server"
        case .analysisError(let message):
            return "Analysis failed: \(message)"
        }
    }
} 