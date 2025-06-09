import Foundation
import SwiftUI
import FirebaseAuth
import PhotosUI
import UIKit

// MARK: - Supporting Models
struct SubmittedPhoto: Identifiable, Equatable {
    let id = UUID()
    let image: UIImage
    let isSuccess: Bool // Analysis success status
    let submittedAt: Date
    
    init(image: UIImage, isSuccess: Bool = true) {
        self.image = image
        self.isSuccess = isSuccess
        self.submittedAt = Date()
    }
}

@MainActor
class MyIngredientsViewModel: ObservableObject {
    
    // MARK: - Published Properties
    @Published var myIngredients = MyIngredientsData()
    @Published var needsReviewIngredients = MyIngredientsData() // New: temporary analysis results
    @Published var isLoading: Bool = false
    @Published var isAnalyzing: Bool = false
    @Published var errorMessage: String? = nil
    @Published var successMessage: String? = nil
    @Published var analysisProgress: String = ""
    
    // MARK: - Input State
    @Published var selectedImages: [UIImage] = []
    @Published var submittedPhotos: [SubmittedPhoto] = [] // Session-persisted submitted photos (max 4)
    @Published var textInput: String = ""
    @Published var selectedCategory: IngredientCategory = .ingredient
    @Published var hasUnsavedChanges: Bool = false
    
    // MARK: - UI State
    @Published var showingImagePicker = false
    @Published var showingCamera = false
    @Published var photoPickerConfig = PHPickerConfiguration()
    
    // MARK: - Services
    private let myIngredientsService: MyIngredientsServiceProtocol
    // private let authService: AuthenticationServiceProtocol
    
    // MARK: - Current User
    private var currentUserId: String? {
        Auth.auth().currentUser?.uid
    }
    
    init(myIngredientsService: MyIngredientsServiceProtocol = MyIngredientsService()) {
        self.myIngredientsService = myIngredientsService
        setupPhotoPickerConfig()
    }
    
    // MARK: - Configuration
    private func setupPhotoPickerConfig() {
        photoPickerConfig.selectionLimit = 0 // Allow multiple selection
        photoPickerConfig.filter = .images
    }
    
    // MARK: - Data Loading
    func loadUserIngredients() async {
        guard let userId = currentUserId else {
            self.errorMessage = "User not authenticated"
            return
        }
        
        isLoading = true
        clearMessages()
        
        do {
            if let ingredients = try await myIngredientsService.getUserIngredients(userId: userId) {
                self.myIngredients = ingredients
                print("MyIngredientsViewModel: Loaded \(ingredients.totalCount()) total items")
            }
        } catch {
            self.errorMessage = "Failed to load ingredients: \(error.localizedDescription)"
            print("MyIngredientsViewModel ERROR: \(error.localizedDescription)")
        }
        
        isLoading = false
    }
    
    func saveUserIngredients() async {
        guard let userId = currentUserId else {
            self.errorMessage = "User not authenticated"
            return
        }

        do {
            // Update timestamp
            myIngredients.lastUpdated = .init()
            
            // Save with reason to trigger proper historization
            let saveReason = determineSaveReason()
            try await myIngredientsService.updateUserIngredients(
                userId: userId, 
                ingredients: myIngredients, 
                reason: saveReason
            )
            
            hasUnsavedChanges = false
            successMessage = "Kitchen inventory saved successfully"
            print("MyIngredientsViewModel: Saved \(myIngredients.totalCount()) total items with reason: \(saveReason)")
        } catch {
            self.errorMessage = "Failed to save ingredients: \(error.localizedDescription)"
            print("MyIngredientsViewModel ERROR: \(error.localizedDescription)")
        }
    }
    
    private func determineSaveReason() -> String {
        // Determine save reason based on context for proper snapshot creation
        if needsReviewCount == 0 && currentCategoryItems.count > 5 {
            return "verify_all" // Triggers snapshot
        } else if hasSignificantChanges() {
            return "major_edit" // Triggers snapshot
        } else {
            return "manual_save" // No snapshot
        }
    }
    
    private func hasSignificantChanges() -> Bool {
        // Logic to determine if changes warrant a snapshot
        let totalItems = myIngredients.totalCount()
        return totalItems > 10 // Simple heuristic - could be more sophisticated
    }
    
    // MARK: - Batch Analysis
    func analyzeMyKitchen() async {
        guard hasInputsToAnalyze else {
            errorMessage = "Please add photos or text to analyze"
            return
        }
        
        isAnalyzing = true
        clearMessages()
        
        // Track analysis start with new event system
        await logAnalysisEvent(
            action: "analysis_started", 
            itemCount: 0, 
            method: getAnalysisMethod(),
            category: selectedCategory.rawValue
        )
        
        do {
            var allDetectedIngredients: [IngredientAnalysisResponse.DetectedIngredient] = []
            var overallConfidence: Double = 1.0
            
            // Process images if any
            if !selectedImages.isEmpty {
                analysisProgress = "Analyzing \(selectedImages.count) image(s)..."
                for (index, image) in selectedImages.enumerated() {
                    analysisProgress = "Processing image \(index + 1) of \(selectedImages.count)..."
                    
                    let response = try await myIngredientsService.analyzeImage(
                        image, 
                        location: .fridge, // Default location since we're not using location filtering
                        hasAnnotation: false
                    )
                    
                    allDetectedIngredients.append(contentsOf: response.detectedIngredients)
                    overallConfidence = min(overallConfidence, response.confidence)
                }
            }
            
            // Process text if any
            if !textInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                analysisProgress = "Processing text input..."
                
                let response = try await myIngredientsService.analyzeText(
                    textInput, 
                    location: .fridge // Default location
                )
                
                allDetectedIngredients.append(contentsOf: response.detectedIngredients)
                overallConfidence = min(overallConfidence, response.confidence)
            }
            
            // Add detected ingredients
            analysisProgress = "Adding ingredients to your kitchen..."
            await addDetectedIngredients(allDetectedIngredients, category: selectedCategory)
            
            // Track analysis completion with new event system
            await logAnalysisEvent(
                action: "analysis_completed",
                itemCount: allDetectedIngredients.count,
                method: getAnalysisMethod(),
                category: selectedCategory.rawValue
            )
            
            // Move successfully analyzed images to submitted photos (max 4)
            for image in selectedImages {
                addToSubmittedPhotos(image, isSuccess: true)
            }
            
            // Clear inputs after successful analysis
            selectedImages.removeAll()
            textInput = ""
            
            // Set success message
            let categoryName = selectedCategory.displayName.lowercased()
            if overallConfidence < 0.7 {
                successMessage = "Added \(allDetectedIngredients.count) \(categoryName) with lower confidence. Please verify the list below."
            } else {
                successMessage = "Successfully analyzed your kitchen! Added \(allDetectedIngredients.count) \(categoryName)."
            }
            
        } catch {
            self.errorMessage = "Failed to analyze kitchen: \(error.localizedDescription)"
            print("MyIngredientsViewModel ERROR: Kitchen analysis failed - \(error)")
            
            // Track analysis failure with new event system
            await logAnalysisEvent(
                action: "analysis_failed",
                itemCount: 0,
                method: getAnalysisMethod(),
                category: selectedCategory.rawValue
            )
            
            // Move failed images to submitted photos with error status
            for image in selectedImages {
                addToSubmittedPhotos(image, isSuccess: false)
            }
            
            // Clear failed inputs
            selectedImages.removeAll()
        }
        
        isAnalyzing = false
        analysisProgress = ""
    }
    
    // MARK: - Image Management
    func addImages(_ images: [UIImage]) {
        // Replace all existing images with new ones
        selectedImages.removeAll()
        selectedImages.append(contentsOf: images)
    }
    
    func takePhoto() {
        showingCamera = true
    }
    
    func selectFromPhotos() {
        showingImagePicker = true
    }
    
    func addSubmittedPhotoToCurrentSelection(_ submittedPhoto: SubmittedPhoto) {
        // Add the submitted photo back to current selection for re-analysis
        if !selectedImages.contains(where: { $0.pngData() == submittedPhoto.image.pngData() }) {
            selectedImages.append(submittedPhoto.image)
        }
    }
    
    private func addToSubmittedPhotos(_ image: UIImage, isSuccess: Bool) {
        let submittedPhoto = SubmittedPhoto(image: image, isSuccess: isSuccess)
        
        // Add to beginning of array and limit to 4 items
        submittedPhotos.insert(submittedPhoto, at: 0)
        if submittedPhotos.count > 4 {
            submittedPhotos = Array(submittedPhotos.prefix(4))
        }
    }
    
    // MARK: - Ingredient Management
    private func addDetectedIngredients(_ detectedIngredients: [IngredientAnalysisResponse.DetectedIngredient], category: IngredientCategory) async {
        // Clear previous review items for this category first
        needsReviewIngredients.setItemsForCategory(category, items: [])
        
        for detected in detectedIngredients {
            let ingredient = MyIngredient(
                name: detected.name,
                location: IngredientLocation(rawValue: detected.location) ?? .fridge,
                quantity: nil, // Simplified: all categories are boolean availability
                isVerified: false,
                confidence: detected.confidence,
                category: category,
                isAvailable: true
            )
            
            // Check if already exists in permanent kitchen
            let existsInKitchen = myIngredients.itemsForCategory(category).contains { 
                $0.name.lowercased() == ingredient.name.lowercased() 
            }
            
            if !existsInKitchen {
                // Add to needs review instead of permanent kitchen
                needsReviewIngredients.addItemToCategory(category, item: ingredient)
            }
        }
    }
    
    func toggleIngredientVerification(_ ingredient: MyIngredient) {
        if ingredient.category == .ingredient {
            if let index = myIngredients.ingredients.firstIndex(where: { $0.id == ingredient.id }) {
                myIngredients.ingredients[index].isVerified.toggle()
                hasUnsavedChanges = true
            }
        } else {
            if let index = myIngredients.spices.firstIndex(where: { $0.id == ingredient.id }) {
                myIngredients.spices[index].isVerified.toggle()
                hasUnsavedChanges = true
            }
        }
    }
    
    func verifyAllCurrentCategory() {
        if selectedCategory == .ingredient {
            for index in myIngredients.ingredients.indices {
                if !myIngredients.ingredients[index].isVerified {
                    myIngredients.ingredients[index].isVerified = true
                    hasUnsavedChanges = true
                }
            }
        } else {
            for index in myIngredients.spices.indices {
                if !myIngredients.spices[index].isVerified {
                    myIngredients.spices[index].isVerified = true
                    hasUnsavedChanges = true
                }
            }
        }
    }
    
    func updateIngredientQuantity(_ ingredient: MyIngredient, quantity: String) {
        guard ingredient.category == .ingredient else { return } // Spices don't have quantities
        
        if let index = myIngredients.ingredients.firstIndex(where: { $0.id == ingredient.id }) {
            myIngredients.ingredients[index].quantity = quantity.isEmpty ? nil : quantity
            hasUnsavedChanges = true
        }
    }
    
    func toggleSpiceAvailability(_ spice: MyIngredient) {
        guard spice.category == .spice else { return }
        
        if let index = myIngredients.spices.firstIndex(where: { $0.id == spice.id }) {
            myIngredients.spices[index].isAvailable.toggle()
            hasUnsavedChanges = true
        }
    }
    
    func removeIngredient(_ ingredient: MyIngredient) {
        if ingredient.category == .ingredient {
            myIngredients.ingredients.removeAll { $0.id == ingredient.id }
        } else {
            myIngredients.spices.removeAll { $0.id == ingredient.id }
        }
        hasUnsavedChanges = true
        
        // Log removal event
        Task {
            await logAnalysisEvent(
                action: "item_removed",
                itemCount: 1,
                method: "manual",
                category: ingredient.category.rawValue
            )
        }
    }
    
    func addManualIngredient(name: String, category: IngredientCategory) {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        
        let ingredient = MyIngredient(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            location: .fridge, // Default location
            quantity: nil, // Simplified: all categories are boolean availability
            isVerified: true, // Manual entries go directly to kitchen
            confidence: 1.0,
            category: category,
            isAvailable: true
        )
        
        // Add directly to permanent kitchen inventory
        myIngredients.addItemToCategory(category, item: ingredient)
        hasUnsavedChanges = true
        
        // Log addition event
        Task {
            await logAnalysisEvent(
                action: "item_added",
                itemCount: 1,
                method: "manual",
                category: category.rawValue
            )
        }
    }
    
    // MARK: - Helper Methods
    var hasInputsToAnalyze: Bool {
        !selectedImages.isEmpty || !textInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    
    var currentKitchenItems: [MyIngredient] {
        return myIngredients.itemsForCategory(selectedCategory)
    }
    
    var needsReviewItems: [MyIngredient] {
        return needsReviewIngredients.itemsForCategory(selectedCategory)
    }
    
    var currentCategoryItems: [MyIngredient] {
        return currentKitchenItems + needsReviewItems
    }
    
    var needsReviewCount: Int {
        return needsReviewItems.count
    }
    
    var totalNeedsReviewCount: Int {
        return needsReviewIngredients.ingredients.count + 
               needsReviewIngredients.spices.count + 
               needsReviewIngredients.sauces.count
    }
    
    var kitchenInventoryCount: Int {
        return currentKitchenItems.count
    }
    
    func getIngredientsForRecipeContext() -> String {
        let allIngredients = myIngredients.ingredients
        let availableSpices = myIngredients.spices.filter { $0.isAvailable }
        
        if allIngredients.isEmpty && availableSpices.isEmpty {
            return "No ingredients available."
        }
        
        var context = ""
        
        // Add ingredients with quantities
        if !allIngredients.isEmpty {
            let ingredientList = allIngredients.map { ingredient in
                if let quantity = ingredient.quantity {
                    return "\(ingredient.name) (\(quantity))"
                } else {
                    return ingredient.name
                }
            }.joined(separator: ", ")
            context += "Available ingredients: \(ingredientList)"
        }
        
        // Add available spices
        if !availableSpices.isEmpty {
            let spiceList = availableSpices.map { $0.name }.joined(separator: ", ")
            if !context.isEmpty { context += "\n" }
            context += "Available spices: \(spiceList)"
        }
        
        return context
    }
    
    private func getAnalysisMethod() -> String {
        var methods: [String] = []
        if !selectedImages.isEmpty { methods.append("image") }
        if !textInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { methods.append("text") }
        return methods.joined(separator: "_")
    }
    
    // MARK: - New Event Logging System
    private func logAnalysisEvent(action: String, itemCount: Int, method: String, category: String) async {
        guard let userId = currentUserId else { return }
        
        let event = IngredientHistoryEvent(
            userId: userId,
            action: action,
            method: method,
            itemCount: itemCount,
            category: category
        )
        
        do {
            try await myIngredientsService.logHistoryEvent(userId: userId, event: event)
        } catch {
            print("MyIngredientsViewModel ERROR: Failed to log history event: \(error.localizedDescription)")
        }
    }
    
    // MARK: - Legacy Support (for migration)
    @available(*, deprecated, message: "Use new event logging system")
    private func addHistoryEntry(action: String, itemCount: Int, method: String) {
        // Legacy method kept for compilation compatibility
        // Will be removed in future version
        print("MyIngredientsViewModel: Legacy addHistoryEntry called - migrating to new system")
        
        Task {
            await logAnalysisEvent(
                action: action,
                itemCount: itemCount,
                method: method,
                category: selectedCategory.rawValue
            )
        }
    }
    
    private func clearMessages() {
        errorMessage = nil
        successMessage = nil
    }
    
    // MARK: - Dual-State Management
    
    func confirmItemToKitchen(_ item: MyIngredient) {
        // Move from needs review to permanent kitchen
        needsReviewIngredients.removeItemFromCategory(item.category, itemId: item.id)
        
        // Add to kitchen with confirmed status
        var confirmedItem = item
        confirmedItem.isVerified = true
        myIngredients.addItemToCategory(item.category, item: confirmedItem)
        
        hasUnsavedChanges = true
    }
    
    func denyReviewItem(_ item: MyIngredient) {
        // Simply remove from review list
        needsReviewIngredients.removeItemFromCategory(item.category, itemId: item.id)
    }
    
    func confirmAllReviewItems() {
        // Move all needs review items to kitchen
        for item in needsReviewItems {
            confirmItemToKitchen(item)
        }
    }
    
    func clearAllReviewItems() {
        // Clear all needs review items
        needsReviewIngredients = MyIngredientsData()
    }
    
    func toggleKitchenItemAvailability(_ item: MyIngredient) {
        // Toggle availability in permanent kitchen inventory
        if let index = currentKitchenItems.firstIndex(where: { $0.id == item.id }) {
            var updatedItems = currentKitchenItems
            updatedItems[index].isAvailable.toggle()
            myIngredients.setItemsForCategory(item.category, items: updatedItems)
            hasUnsavedChanges = true
        }
    }
    
    func removeFromKitchen(_ item: MyIngredient) {
        // Remove from permanent kitchen inventory
        myIngredients.removeItemFromCategory(item.category, itemId: item.id)
        hasUnsavedChanges = true
    }
    
    // MARK: - Clear All for Current Category
    func clearAllItemsForCurrentCategory() {
        // Clear both current kitchen items and needs review items for the selected category
        var updatedMyIngredients = myIngredients
        
        // Clear from current kitchen items
        updatedMyIngredients.setItemsForCategory(selectedCategory, items: [])
        
        // Clear from needs review items (modify the underlying @Published property)
        var updatedNeedsReview = needsReviewIngredients
        updatedNeedsReview.setItemsForCategory(selectedCategory, items: [])
        needsReviewIngredients = updatedNeedsReview
        
        // Update the main data
        myIngredients = updatedMyIngredients
        hasUnsavedChanges = true
        
        // Save automatically
        Task {
            await saveUserIngredients()
        }
    }
} 