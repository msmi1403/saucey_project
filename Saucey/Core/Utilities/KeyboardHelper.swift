import SwiftUI
import UIKit
import Combine

// MARK: - Keyboard Helper Service
class KeyboardHelper: ObservableObject {
    @Published var isKeyboardVisible = false
    @Published var keyboardHeight: CGFloat = 0
    
    private var cancellables = Set<AnyCancellable>()
    
    init() {
        setupKeyboardObservers()
    }
    
    private func setupKeyboardObservers() {
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
            .sink { [weak self] notification in
                if let keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
                    self?.keyboardHeight = keyboardFrame.height
                    self?.isKeyboardVisible = true
                }
            }
            .store(in: &cancellables)
        
        NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
            .sink { [weak self] _ in
                self?.keyboardHeight = 0
                self?.isKeyboardVisible = false
            }
            .store(in: &cancellables)
    }
    
    /// Dismisses the keyboard programmatically
    static func dismissKeyboard() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

// MARK: - SwiftUI View Extension for Keyboard Dismissal
extension View {
    /// Adds tap gesture to dismiss keyboard when tapping outside of text fields
    func dismissKeyboardOnTap() -> some View {
        self.onTapGesture {
            KeyboardHelper.dismissKeyboard()
        }
    }
    
    /// Adds keyboard-aware padding that adjusts when keyboard appears
    func keyboardAware(_ keyboardHelper: KeyboardHelper) -> some View {
        self.padding(.bottom, keyboardHelper.isKeyboardVisible ? keyboardHelper.keyboardHeight : 0)
            .animation(.easeInOut(duration: 0.3), value: keyboardHelper.isKeyboardVisible)
    }
} 