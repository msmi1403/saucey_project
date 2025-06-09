import SwiftUI
import PhotosUI
import UIKit

struct MyIngredientsView: View {
    @StateObject private var viewModel = MyIngredientsViewModel()
    @StateObject private var speechRecognizer = SpeechRecognizer()
    @StateObject private var keyboardHelper = KeyboardHelper()
    
    @Environment(\.colorScheme) var colorScheme
    
    // Manual entry state
    @State private var manualEntryName: String = ""
    @State private var sectionExpandedState: [String: Bool] = [:]
    @State private var isAddingNewItem: Bool = false
    @FocusState private var isNewItemNameFocused: Bool
    
    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                // Category tabs
                categoryTabsSection
                
                // Main content - always show sectioned view, it handles empty state internally
                sectionedIngredientsView
            }
            .navigationTitle("My Kitchen")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .navigationBarTrailing) {
                    // Clear All button
                    if !viewModel.currentKitchenItems.isEmpty || !viewModel.needsReviewItems.isEmpty {
                        Button("Clear All") {
                            presentClearAllConfirmationAlert()
                        }
                        .foregroundColor(.red)
                        .disabled(viewModel.isLoading || viewModel.isAnalyzing)
                    }
                    
                    // Save button
                    if viewModel.hasUnsavedChanges {
                        Button("Save") {
                            Task {
                                await viewModel.saveUserIngredients()
                            }
                        }
                        .disabled(viewModel.isLoading || viewModel.isAnalyzing)
                    }
                }
            }
            .onAppear {
                Task {
                    await viewModel.loadUserIngredients()
                }
                // Initialize section expanded states
                IngredientLocation.allCases.forEach { location in
                    if sectionExpandedState[location.rawValue] == nil {
                        sectionExpandedState[location.rawValue] = true
                    }
                }
            }
            .sheet(isPresented: $viewModel.showingImagePicker) {
                PhotoPickerView(
                    configuration: viewModel.photoPickerConfig,
                    onImagesSelected: { images in
                        viewModel.addImages(images)
                    }
                )
            }
            .sheet(isPresented: $viewModel.showingCamera) {
                CameraView { image in
                    if let image = image {
                        viewModel.addImages([image])
                    }
                }
            }
            .dismissKeyboardOnTap()
        }
    }
    
    // MARK: - Category Tabs
    private var categoryTabsSection: some View {
        Picker("Category", selection: $viewModel.selectedCategory) {
            ForEach(IngredientCategory.allCases) { category in
                Text(category.displayName)
                    .tag(category)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        .padding(.top, 8)
    }
    
    // MARK: - Empty State View
    private var emptyStateView: some View {
        VStack(spacing: 24) {
            Spacer()
            
            VStack(spacing: 16) {
                Image(systemName: "refrigerator.fill")
                    .font(.system(size: 60))
                    .foregroundColor(.secondary)
                
                VStack(spacing: 8) {
                    Text("Your Kitchen is Empty")
                        .font(.title2)
                        .fontWeight(.semibold)
                    
                    Text("Add \(viewModel.selectedCategory.displayName.lowercased()) by taking photos, entering text, or adding manually")
                        .font(.body)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
            }
            
            // Photo action buttons
            VStack(spacing: 16) {
                HStack(spacing: 20) {
                    Button(action: { viewModel.takePhoto() }) {
                        VStack(spacing: 8) {
                            Image(systemName: "camera.fill")
                                .font(.system(size: 32))
                            Text("Take Photo")
                                .font(.headline)
                                .fontWeight(.semibold)
                        }
                        .frame(width: 140, height: 100)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .cornerRadius(16)
                        .shadow(radius: 4)
                    }
                    
                    Button(action: { viewModel.selectFromPhotos() }) {
                        VStack(spacing: 8) {
                            Image(systemName: "photo.fill")
                                .font(.system(size: 32))
                            Text("From Photos")
                                .font(.headline)
                                .fontWeight(.semibold)
                        }
                        .frame(width: 140, height: 100)
                        .background(Color.green)
                        .foregroundColor(.white)
                        .cornerRadius(16)
                        .shadow(radius: 4)
                    }
                }
                
                // Text input section
                VStack(spacing: 12) {
                    Divider()
                    
                    Text("Or add by text/voice")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                    
                    HStack(spacing: 10) {
                        TextField("e.g., 2 apples, milk, bread, olive oil...", text: $viewModel.textInput, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(2...4)
                        
                        Button(action: {
                            if speechRecognizer.isRecording {
                                speechRecognizer.stopTranscribing()
                                viewModel.textInput = speechRecognizer.transcribedText
                            } else {
                                speechRecognizer.startTranscribing()
                            }
                        }) {
                            Image(systemName: speechRecognizer.isRecording ? "mic.fill" : "mic")
                                .font(.title3)
                                .foregroundColor(speechRecognizer.isRecording ? .red : .accentColor)
                                .frame(width: 44, height: 44)
                                .background(Color(UIColor.systemBackground))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(speechRecognizer.isRecording ? Color.red : Color.accentColor, lineWidth: 1)
                                )
                                .cornerRadius(8)
                        }
                    }
                    .padding(.horizontal)
                    
                    // Analyze button
                    Button(action: {
                        Task { await viewModel.analyzeMyKitchen() }
                    }) {
                        HStack {
                            if viewModel.isAnalyzing {
                                ProgressView()
                                    .scaleEffect(0.8)
                            }
                            Text(viewModel.isAnalyzing ? "Analyzing..." : "Analyze My Kitchen")
                                .fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(viewModel.hasInputsToAnalyze ? Color.accentColor : Color.gray.opacity(0.3))
                        .foregroundColor(viewModel.hasInputsToAnalyze ? .white : .gray)
                        .cornerRadius(12)
                    }
                    .disabled(!viewModel.hasInputsToAnalyze || viewModel.isAnalyzing)
                    .padding(.horizontal)
                }
            }
            
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    // MARK: - Sectioned Ingredients View (Grocery Cart Style)
    private var sectionedIngredientsView: some View {
        ZStack(alignment: .bottomLeading) {
            ScrollViewReader { proxy in
                List {
                    // Header status section
                    headerStatusSection
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets())
                    
                    // Always visible photo action buttons and input section
                    photoActionSection
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets())
                    
                    // Image carousel and text input (when there are items)
                    if !viewModel.selectedImages.isEmpty || !viewModel.textInput.isEmpty || viewModel.isAnalyzing {
                        imageCarouselAndTextSection
                            .listRowSeparator(.hidden)
                            .listRowInsets(EdgeInsets())
                    }
                    
                    // Needs Review section
                    if !viewModel.needsReviewItems.isEmpty {
                        needsReviewSection
                    }
                    
                    // Empty state (when no items and not adding)
                    if viewModel.currentKitchenItems.isEmpty && viewModel.needsReviewItems.isEmpty && !isAddingNewItem && !keyboardHelper.isKeyboardVisible {
                        emptyStateInListSection
                    }
                    
                    // My Kitchen sections by location
                    let sectionsForDisplay = getLocationSectionsForDisplay()
                    ForEach(sectionsForDisplay, id: \.rawValue) { location in
                        let itemsInSection = getItemsForLocation(location)
                        if !itemsInSection.isEmpty {
                            Section {
                                ForEach(itemsInSection) { ingredient in
                                    IngredientListItemRowView(
                                        ingredient: ingredient,
                                        onToggleAvailability: {
                                            viewModel.toggleKitchenItemAvailability(ingredient)
                                        },
                                        onRemove: {
                                            viewModel.removeFromKitchen(ingredient)
                                        }
                                    )
                                    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 10))
                                }
                            } header: {
                                Text(location.displayName)
                                    .font(.title3)
                                    .fontWeight(.semibold)
                                    .foregroundColor(.primary)
                            }
                        }
                    }
                    
                    // Inline new item row
                    if isAddingNewItem {
                        NewIngredientItemInputRow(
                            itemName: $manualEntryName,
                            category: viewModel.selectedCategory,
                            isFocused: $isNewItemNameFocused,
                            onCommit: handleInlineItemCommit,
                            onCancel: handleInlineItemCancel
                        )
                        .id("newItemRow")
                        .listRowInsets(EdgeInsets(top: 5, leading: 0, bottom: 5, trailing: 10))
                    }
                    
                    // Bottom spacer
                    Color.clear.frame(height: 70).listRowSeparator(.hidden)
                }
                .listStyle(.plain)
                .onChange(of: isAddingNewItem) { oldVal, newVal in
                    if newVal {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                            withAnimation {
                                proxy.scrollTo("newItemRow", anchor: .bottom)
                            }
                        }
                    }
                }
            }
            
            // New Item button (grocery cart style)
            VStack {
                Spacer()
                HStack {
                    Button {
                        prepareAndShowInlineAddItem()
                    } label: {
                        Label("New Item", systemImage: "plus.circle.fill")
                            .font(.headline)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(.thinMaterial)
                            .clipShape(Capsule())
                            .shadow(radius: 3)
                    }
                    .disabled(isAddingNewItem || viewModel.isAnalyzing)
                    .padding(.leading, 20)
                    .padding(.bottom, 10)
                    
                    Spacer()
                }
            }
        }
    }
    
    // MARK: - Header Status Section
    private var headerStatusSection: some View {
        VStack(spacing: 12) {
            // Kitchen status summary
            HStack(spacing: 16) {
                if viewModel.kitchenInventoryCount > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        Text("\(viewModel.kitchenInventoryCount) in kitchen")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }
                
                if viewModel.needsReviewCount > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .foregroundColor(.orange)
                        Text("\(viewModel.needsReviewCount) to review")
                            .font(.caption)
                            .foregroundColor(.orange)
                    }
                }
                
                Spacer()
            }
            .padding(.horizontal)
            
            // Status messages
            if let errorMessage = viewModel.errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundColor(.red)
                    .padding(.horizontal)
            }
            
            if let successMessage = viewModel.successMessage {
                Text(successMessage)
                    .font(.caption)
                    .foregroundColor(.green)
                    .padding(.horizontal)
            }
            
            if viewModel.isAnalyzing && !viewModel.analysisProgress.isEmpty {
                Text(viewModel.analysisProgress)
                    .font(.caption)
                    .foregroundColor(.blue)
                    .padding(.horizontal)
            }
        }
        .padding(.vertical, 8)
    }
    
    // MARK: - Photo Action Section (Always Visible)
    private var photoActionSection: some View {
        VStack(spacing: keyboardHelper.isKeyboardVisible ? 8 : 16) {
            // Photo action buttons and text input - compact when keyboard visible
            if keyboardHelper.isKeyboardVisible {
                // Compact layout when keyboard is open
                VStack(spacing: 8) {
                    HStack(spacing: 12) {
                        Button(action: { viewModel.takePhoto() }) {
                            HStack(spacing: 4) {
                                Image(systemName: "camera.fill")
                                    .font(.system(size: 16))
                                Text("Camera")
                                    .font(.caption)
                                    .fontWeight(.medium)
                            }
                            .frame(width: 80, height: 35)
                            .background(Color.accentColor)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                        }
                        .disabled(viewModel.isAnalyzing)
                        
                        Button(action: { viewModel.selectFromPhotos() }) {
                            HStack(spacing: 4) {
                                Image(systemName: "photo.fill")
                                    .font(.system(size: 16))
                                Text("Photos")
                                    .font(.caption)
                                    .fontWeight(.medium)
                            }
                            .frame(width: 80, height: 35)
                            .background(Color.green)
                            .foregroundColor(.white)
                            .cornerRadius(8)
                        }
                        .disabled(viewModel.isAnalyzing)
                        
                        Spacer()
                        
                        Button(action: {
                            if speechRecognizer.isRecording {
                                speechRecognizer.stopTranscribing()
                                viewModel.textInput = speechRecognizer.transcribedText
                            } else {
                                speechRecognizer.startTranscribing()
                            }
                        }) {
                            Image(systemName: speechRecognizer.isRecording ? "mic.fill" : "mic")
                                .font(.system(size: 16))
                                .foregroundColor(speechRecognizer.isRecording ? .red : .accentColor)
                                .frame(width: 35, height: 35)
                                .background(Color(UIColor.systemBackground))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(speechRecognizer.isRecording ? Color.red : Color.accentColor, lineWidth: 1)
                                )
                                .cornerRadius(8)
                        }
                        .disabled(viewModel.isAnalyzing)
                    }
                    
                    TextField("Add ingredients by text...", text: $viewModel.textInput, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...3)
                        .disabled(viewModel.isAnalyzing)
                        .toolbar {
                            ToolbarItemGroup(placement: .keyboard) {
                                Spacer()
                                Button("Done") {
                                    KeyboardHelper.dismissKeyboard()
                                }
                            }
                        }
                }
                .padding(.horizontal)
            } else {
                // Full layout when keyboard is hidden
                HStack(spacing: 20) {
                    Button(action: { viewModel.takePhoto() }) {
                        VStack(spacing: 6) {
                            Image(systemName: "camera.fill")
                                .font(.system(size: 22))
                            Text("Camera")
                                .font(.subheadline)
                                .fontWeight(.medium)
                        }
                        .frame(width: 90, height: 70)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                        .shadow(radius: 2)
                    }
                    .disabled(viewModel.isAnalyzing)
                    
                    Button(action: { viewModel.selectFromPhotos() }) {
                        VStack(spacing: 6) {
                            Image(systemName: "photo.fill")
                                .font(.system(size: 22))
                            Text("Photos")
                                .font(.subheadline)
                                .fontWeight(.medium)
                        }
                        .frame(width: 90, height: 70)
                        .background(Color.green)
                        .foregroundColor(.white)
                        .cornerRadius(12)
                        .shadow(radius: 2)
                    }
                    .disabled(viewModel.isAnalyzing)
                    
                    Spacer()
                    
                    // Text/Voice input in the same row for efficiency
                    HStack(spacing: 8) {
                        TextField("Add by text...", text: $viewModel.textInput, axis: .vertical)
                            .textFieldStyle(.roundedBorder)
                            .lineLimit(1...2)
                            .disabled(viewModel.isAnalyzing)
                            .toolbar {
                                ToolbarItemGroup(placement: .keyboard) {
                                    Spacer()
                                    Button("Done") {
                                        KeyboardHelper.dismissKeyboard()
                                    }
                                }
                            }
                        
                        Button(action: {
                            if speechRecognizer.isRecording {
                                speechRecognizer.stopTranscribing()
                                viewModel.textInput = speechRecognizer.transcribedText
                            } else {
                                speechRecognizer.startTranscribing()
                            }
                        }) {
                            Image(systemName: speechRecognizer.isRecording ? "mic.fill" : "mic")
                                .font(.title3)
                                .foregroundColor(speechRecognizer.isRecording ? .red : .accentColor)
                                .frame(width: 38, height: 38)
                                .background(Color(UIColor.systemBackground))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(speechRecognizer.isRecording ? Color.red : Color.accentColor, lineWidth: 1)
                                )
                                .cornerRadius(8)
                        }
                        .disabled(viewModel.isAnalyzing)
                    }
                    .frame(maxWidth: 200)
                }
                .padding(.horizontal)
            }
            
            // Analyze button (always visible if there are inputs)
            if viewModel.hasInputsToAnalyze {
                Button(action: {
                    Task { await viewModel.analyzeMyKitchen() }
                }) {
                    HStack {
                        if viewModel.isAnalyzing {
                            ProgressView()
                                .scaleEffect(0.8)
                        }
                        Text(viewModel.isAnalyzing ? "Analyzing..." : "Analyze My Kitchen")
                            .fontWeight(.semibold)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, keyboardHelper.isKeyboardVisible ? 10 : 12)
                    .background(Color.accentColor)
                    .foregroundColor(.white)
                    .cornerRadius(10)
                }
                .disabled(viewModel.isAnalyzing)
                .padding(.horizontal)
            }
        }
        .padding(.vertical, keyboardHelper.isKeyboardVisible ? 6 : 8)
        .animation(.easeInOut(duration: 0.25), value: keyboardHelper.isKeyboardVisible)
    }
    
    // MARK: - Image Carousel and Text Section (When Items Present)
    private var imageCarouselAndTextSection: some View {
        VStack(spacing: 12) {
            // Selected images preview
            if !viewModel.selectedImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(0..<viewModel.selectedImages.count, id: \.self) { index in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: viewModel.selectedImages[index])
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: 60, height: 60)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                
                                Button(action: {
                                    viewModel.selectedImages.remove(at: index)
                                }) {
                                    Image(systemName: "xmark.circle.fill")
                                        .foregroundColor(.red)
                                        .background(Color.white)
                                        .clipShape(Circle())
                                        .font(.caption)
                                }
                                .offset(x: 5, y: -5)
                            }
                        }
                    }
                    .padding(.horizontal)
                }
            }
            
            // Analysis progress indicator
            if viewModel.isAnalyzing && !viewModel.analysisProgress.isEmpty {
                Text(viewModel.analysisProgress)
                    .font(.caption)
                    .foregroundColor(.blue)
                    .padding(.horizontal)
            }
        }
        .padding(.vertical, 8)
    }
    
    // MARK: - Needs Review Section
    private var needsReviewSection: some View {
        Section {
            ForEach(viewModel.needsReviewItems) { ingredient in
                NeedsReviewRowView(
                    ingredient: ingredient,
                    onConfirm: { viewModel.confirmItemToKitchen(ingredient) },
                    onDeny: { viewModel.denyReviewItem(ingredient) }
                )
                .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 10))
            }
            
            // Bulk actions
            HStack {
                Button("Confirm All") {
                    viewModel.confirmAllReviewItems()
                }
                .font(.caption)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.green)
                .foregroundColor(.white)
                .cornerRadius(8)
                
                Button("Clear All") {
                    viewModel.clearAllReviewItems()
                }
                .font(.caption)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.red)
                .foregroundColor(.white)
                .cornerRadius(8)
                
                Spacer()
            }
            .padding(.horizontal)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets())
            
        } header: {
            HStack {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundColor(.orange)
                Text("Items to Review")
                    .font(.title3)
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
            }
        }
    }
    
    // MARK: - Empty State in List Section
    private var emptyStateInListSection: some View {
        VStack(spacing: 20) {
            VStack(spacing: 12) {
                Image(systemName: "refrigerator.fill")
                    .font(.system(size: 50))
                    .foregroundColor(.secondary)
                
                VStack(spacing: 6) {
                    Text("Your Kitchen is Empty")
                        .font(.title3)
                        .fontWeight(.semibold)
                    
                    Text("Add \(viewModel.selectedCategory.displayName.lowercased()) using the buttons above")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            
            Text("This AI is learning to be a kitchen detective! 🕵️‍♀️ Results may vary - feel free to add, remove, or correct anything!")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets())
    }
    
    // MARK: - Helper Methods
    private func getLocationSectionsForDisplay() -> [IngredientLocation] {
        let currentItems = getFilteredKitchenItems()
        let locationsWithItems = Set(currentItems.map { $0.location })
        return IngredientLocation.allCases.filter { locationsWithItems.contains($0) }
    }
    
    private func getItemsForLocation(_ location: IngredientLocation) -> [MyIngredient] {
        return getFilteredKitchenItems().filter { $0.location == location }
    }
    
    private func getFilteredKitchenItems() -> [MyIngredient] {
        return viewModel.currentKitchenItems
    }
    
    private func prepareAndShowInlineAddItem() {
        guard !isAddingNewItem else { return }
        manualEntryName = ""
        isAddingNewItem = true
        isNewItemNameFocused = true
    }
    
    private func handleInlineItemCommit() {
        let name = manualEntryName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            handleInlineItemCancel()
            return
        }
        
        viewModel.addManualIngredient(
            name: name,
            category: viewModel.selectedCategory
        )
        
        isAddingNewItem = false
        manualEntryName = ""
    }
    
    private func handleInlineItemCancel() {
        isAddingNewItem = false
        manualEntryName = ""
    }
    
    private func presentClearAllConfirmationAlert() {
        let categoryName = viewModel.selectedCategory.displayName
        let alert = UIAlertController(
            title: "Clear All \(categoryName)?",
            message: "Are you sure you want to remove all \(categoryName.lowercased()) from your kitchen? This cannot be undone.",
            preferredStyle: .alert
        )
        
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Clear All", style: .destructive) { _ in
            viewModel.clearAllItemsForCurrentCategory()
        })
        
        guard let topVC = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first?.windows.filter({ $0.isKeyWindow }).first?.rootViewController else { return }
        topVC.present(alert, animated: true)
    }
}

// MARK: - Ingredient List Item Row (Grocery Cart Style)
struct IngredientListItemRowView: View {
    let ingredient: MyIngredient
    let onToggleAvailability: () -> Void
    let onRemove: () -> Void
    
    var body: some View {
        HStack {
            Button(action: onToggleAvailability) {
                Image(systemName: ingredient.isAvailable ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(ingredient.isAvailable ? .accentColor : Color(UIColor.systemGray3))
                    .font(.title2)
            }
            .buttonStyle(.plain)
            
            VStack(alignment: .leading, spacing: 2) {
                Text(ingredient.name)
                    .strikethrough(!ingredient.isAvailable, color: .secondary)
                    .foregroundColor(ingredient.isAvailable ? .primary : .secondary)
                    .fontWeight(ingredient.isAvailable ? .medium : .regular)
            }
            
            Spacer()
            
            // Location badge (like grocery cart's recipe tags)
            Text(ingredient.location.displayName)
                .font(.caption)
                .foregroundColor(.orange)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.orange.opacity(0.15))
                .clipShape(Capsule())
            
            Button(action: onRemove) {
                Image(systemName: "minus.circle.fill")
                    .foregroundColor(.red)
                    .font(.title3)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 8)
        .padding(.horizontal)
        .contentShape(Rectangle())
    }
}

// MARK: - New Ingredient Input Row (Grocery Cart Style)
struct NewIngredientItemInputRow: View {
    @Binding var itemName: String
    let category: IngredientCategory
    @FocusState.Binding var isFocused: Bool
    let onCommit: () -> Void
    let onCancel: () -> Void
    
    var body: some View {
        HStack {
            Image(systemName: "plus.circle.fill")
                .foregroundColor(.accentColor)
                .font(.title2)
            
            TextField("Enter \(category.displayName.lowercased()) name...", text: $itemName)
                .focused($isFocused)
                .onSubmit {
                    onCommit()
                }
                .submitLabel(.done)
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") {
                            KeyboardHelper.dismissKeyboard()
                        }
                    }
                }
            
            Button("Cancel") {
                onCancel()
            }
            .font(.caption)
            .foregroundColor(.secondary)
        }
        .padding(.vertical, 8)
        .padding(.horizontal)
        .onAppear {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                isFocused = true
            }
        }
    }
}

// MARK: - Supporting Views (keep existing)
struct PhotoPickerView: UIViewControllerRepresentable {
    let configuration: PHPickerConfiguration
    let onImagesSelected: ([UIImage]) -> Void
    
    func makeUIViewController(context: Context) -> PHPickerViewController {
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }
    
    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: PhotoPickerView
        
        init(_ parent: PhotoPickerView) {
            self.parent = parent
        }
        
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            
            guard !results.isEmpty else { return }
            
            var images: [UIImage] = []
            let group = DispatchGroup()
            
            for result in results {
                group.enter()
                result.itemProvider.loadObject(ofClass: UIImage.self) { image, error in
                    if let uiImage = image as? UIImage {
                        images.append(uiImage)
                    }
                    group.leave()
                }
            }
            
            group.notify(queue: .main) {
                self.parent.onImagesSelected(images)
            }
        }
    }
}

struct CameraView: UIViewControllerRepresentable {
    let onImageCaptured: (UIImage?) -> Void
    
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }
    
    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}
    
    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }
    
    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraView
        
        init(_ parent: CameraView) {
            self.parent = parent
        }
        
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey : Any]) {
            let image = info[.originalImage] as? UIImage
            parent.onImageCaptured(image)
            picker.dismiss(animated: true)
        }
        
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onImageCaptured(nil)
            picker.dismiss(animated: true)
        }
    }
}

struct NeedsReviewRowView: View {
    let ingredient: MyIngredient
    let onConfirm: () -> Void
    let onDeny: () -> Void
    
    var body: some View {
        HStack {
            Image(systemName: "questionmark.circle.fill")
                .foregroundColor(.orange)
                .font(.title2)
            
            VStack(alignment: .leading, spacing: 2) {
                Text(ingredient.name)
                    .font(.body)
                    .fontWeight(.medium)
                
                HStack(spacing: 8) {
                    Text(ingredient.location.displayName)
                        .font(.subheadline)
                        .foregroundColor(Color(UIColor.systemGray2))
                    
                    Text("Confidence: \(Int(ingredient.confidence * 100))%")
                        .font(.subheadline)
                        .foregroundColor(Color(UIColor.systemGray2))
                }
            }
            
            Spacer()
            
            HStack(spacing: 8) {
                Button("Deny") {
                    onDeny()
                }
                .font(.caption)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.red.opacity(0.15))
                .foregroundColor(.red)
                .clipShape(Capsule())
                
                Button("Confirm") {
                    onConfirm()
                }
                .font(.caption)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Color.green)
                .foregroundColor(.white)
                .clipShape(Capsule())
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal)
        .contentShape(Rectangle())
    }
}

#Preview {
    MyIngredientsView()
} 