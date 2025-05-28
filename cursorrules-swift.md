# @label Rules for Saucey Swift Project

## General Swift Best Practices

-   **Clarity and Readability**:
    -   Use clear and descriptive names for variables, constants, functions, and types.
    -   Write self-documenting code. Add comments only when necessary to explain complex logic or non-obvious decisions.
    -   Keep functions and methods short and focused on a single responsibility (SRP - Single Responsibility Principle).
    -   Avoid deeply nested `if/else` statements or loops. Consider using `guard` statements for early exits, or refactoring into smaller functions.
    -   Use Swift's type inference where it improves readability, but explicitly state types if it adds clarity, especially in public APIs or complex expressions.
    - do not add previews structures to files.
-   **Swift API Design Guidelines**:
    -   Follow Swift API Design Guidelines (e.g., naming conventions, fluency of use).
    -   Strive for clarity at the point of use.
-   **Immutability**:
    -   Prefer `let` over `var` wherever possible to promote immutability and reduce side effects.
-   **Optional Handling**:
    -   Use optional chaining (`?`) and optional binding (`if let`, `guard let`) to safely handle optionals.
    -   Avoid force unwrapping (`!`) unless you are absolutely certain that the optional will contain a value at runtime (e.g., IBOutlets after `viewDidLoad`).
-   **Error Handling**:
    -   Use Swift's error handling (`do-try-catch`, `throws`) for recoverable errors.
    -   Avoid using `try!` or `try?` without proper consideration of error paths.
-   **Access Control**:
    -   Use appropriate access control levels (`private`, `fileprivate`, `internal`, `public`, `open`) to encapsulate implementation details and define clear public APIs. Default to the most restrictive level that makes sense.
-   **Performance**:
    -   Be mindful of performance, especially in critical sections like UI updates, data processing, or network requests.
    -   Profile and optimize when necessary, rather than premature optimization.

---
## Architecture (MVVM - Model-View-ViewModel)

The project appears to be using an MVVM-like architecture, especially in the `Features` directory.

-   **Models**:
    -   Represent the data and business logic of the application (e.g., `Recipe`, `UserProfileData`, `Chapter`).
    -   Should be plain Swift structs or classes.
    -   Should be `Codable` if they need to be serialized/deserialized (e.g., from/to JSON, Firestore).
    -   Keep models independent of UI.
-   **Views**:
    -   Responsible for the presentation layer (UI). In SwiftUI, these are `struct`s conforming to `View`.
    -   Should be as "dumb" as possible, meaning they should not contain business logic.
    -   Observe `ViewModel`s for data and delegate user actions to the `ViewModel`.
    -   Use `@StateObject` to create and own `ViewModel` instances for a view or its sub-hierarchy.
    -   Use `@ObservedObject` to reference a `ViewModel` owned by a parent view or injected.
    -   Use `@EnvironmentObject` for `ViewModel`s that need to be shared across a wider view hierarchy.
    -   Example: `ContentView` initializes and owns several `ViewModel`s. `RecipeListView` observes a `RecipeViewModel`.
-   **ViewModels**:
    -   Mediate between the View and the Model.
    -   Prepare and provide data from the Model in a way that the View can easily display.
    -   Handle user interactions delegated from the View.
    -   Contain presentation logic and state for the View.
    -   Should be `class`es conforming to `ObservableObject`.
    -   Use `@Published` properties to notify Views of data changes.
    -   Should not have direct references to UI elements from `UIKit` or `SwiftUI` (except for types like `Image` or `Color` if they are part of the view model's presentable data).
    -   Example: `AuthenticationViewModel` handles login/signup logic. `CookbookViewModel` manages cookbook data and operations.
    -   **Asynchronous Operations**: Perform network requests or other long-running tasks asynchronously (e.g., using `async/await`). Update `@Published` properties on the `@MainActor` to ensure UI updates are on the main thread. Many ViewModels already do this (e.g., `UserProfileViewModel.fetchUserProfileData`).
-   **Services**:
    -   Encapsulate logic for data fetching (e.g., network requests, database interactions), or other distinct functionalities.
    -   Should be injected into ViewModels (dependency injection) to improve testability and decoupling.
    -   Protocols should be used to define the service contracts, allowing for mock implementations in tests.
    -   Examples: `UserProfileService`, `ChapterService`, `NetworkService`.
    -   The `Implementations` subfolder within `Core/Services` houses the concrete service classes.
    -   The `Protocols` subfolder within `Core/Services` defines the service interfaces.

---
## SwiftUI Specifics

-   **State Management**:
    -   `@State`: For transient UI state local to a single view.
    -   `@StateObject`: For creating and managing the lifecycle of an `ObservableObject` (ViewModel) within a view or its sub-hierarchy. The view owns the object.
    -   `@ObservedObject`: For referencing an `ObservableObject` that is owned by another view or passed as a parameter. The view does not own the object.
    -   `@EnvironmentObject`: For accessing an `ObservableObject` that has been placed in the environment by an ancestor view.
    -   `@Binding`: To create a two-way connection between a view and its underlying data (often a `@State` variable in a parent view or a `@Published` property in a ViewModel).
    -   `@AppStorage`: For persisting simple user preferences.
-   **View Composition**:
    -   Break down complex views into smaller, reusable subviews.
    -   Use `@ViewBuilder` for functions or computed properties that return complex view hierarchies.
-   **Navigation**:
    -   Utilize `NavigationStack` for programmatic navigation.
    -   Use `NavigationLink(value:destination:)` for data-driven navigation.
    -   The `NavigationPathRouter` class is used to manage navigation paths.
    -   Deep linking is handled by `DeepLinkManager` and propagated through `ContentView`.
-   **Task Management**:
    -   Use `.task { }` modifier for performing asynchronous work when a view appears.
    -   Use `.task(id:) { }` to automatically cancel and restart tasks when an identity changes.
-   **Avoid Overly Nested Functions/Closures**:
    -   If a function or closure becomes too long or has too many levels of nesting, refactor it.
    -   Extract logic into private helper methods within the View struct or ViewModel.
    -   Use `@ViewBuilder` methods to break down complex `body` computations.
    -   Example of good refactoring: `ContentView`'s `handleDeepLink` and `handleTourNavigationRequest` are separate methods.

---
## Code Structure & Organization

-   **Directory Structure**: The project follows a feature-based grouping (e.g., `Features/Authentication`, `Features/Cookbook`) combined with a domain-based grouping for shared elements (`Core/Services`, `Core/Models`, `Core/UIComponents`). This is a good approach.
    -   `Application`: Core app setup (AppDelegate, App struct, ContentView, root navigation).
    -   `Core`:
        -   `Models`: Data structures used throughout the app, categorized by domain (e.g., `RecipeModels`, `UserModels`).
        -   `Services`: Network, database, and other business logic services, split into `Protocols` and `Implementations`.
        -   `UIComponents`: Reusable SwiftUI views or style kits.
        -   `Utilities`: Helper functions, extensions.
    -   `Features`: Contains modules for specific application features (e.g., `Authentication`, `Cookbook`, `RecipeCreation`). Each feature folder typically contains `Views` and `ViewModels`.
    -   `Assets.xcassets`: For images, colors, etc.
    -   `SauceyTests`, `SauceyUITests`: For unit and UI tests.
-   **File Naming**:
    -   Follow Swift conventions (e.g., `UpperCamelCase` for types, `lowerCamelCase` for functions and variables).
    -   File names should match the primary type they contain.
-   **Extensions**:
    -   Use extensions to organize code within types or to add functionality to existing types. Place them in a logical location, often in the same file as the primary type definition if small, or in separate files (e.g., `Date+Formatting.swift`) if they are substantial or generic.

---
## Asynchronous Programming

-   **`async/await`**:
    -   Use `async/await` for asynchronous operations to write cleaner, more readable code than completion handlers or Combine chains for simple async tasks.
    -   Mark functions that perform asynchronous work with `async`.
    -   Call `async` functions using `await`.
    -   Example: `AuthenticationViewModel.signUp` uses `async/await`.
-   **`@MainActor`**:
    -   Use `@MainActor` to ensure that UI updates and access to UI-related properties happen on the main thread.
    -   ViewModels that publish changes to the UI should typically be marked with `@MainActor` or ensure their `@Published` properties are updated on the main thread. Many ViewModels are already correctly using `@MainActor`.
-   **`Task`**:
    -   Use `Task { ... }` to start asynchronous work, especially from synchronous contexts or to create detached tasks.
    -   Be mindful of the task's lifecycle and cancellation.
    -   When updating UI from a `Task`, ensure it's done on the `@MainActor`.
    -   Example: `ContentView` uses `Task` in `.onAppear` and `onChange` handlers.

---
## Error Handling and Debugging

-   **Logging**:
    -   Use `print()` for temporary debugging, but consider a more robust logging framework for production builds (e.g., OSLog) if detailed logging is needed.
    -   The project currently uses `print()` extensively for debugging state changes and flow, which is fine for development but should be reviewed for release. Examples: `SauceyApp.init`, `ContentView.onOpenURL`, `DeepLinkManager.handleIncomingURL`.
-   **Alerts for Errors**:
    -   Present user-facing errors gracefully, often using `.alert` modifiers in SwiftUI.
    -   `RecipeDetailViewModel` shows how errors might be published for the view to display.
-   **Firebase and Network Errors**:
    -   Handle errors from Firebase services and network calls specifically.
    -   The `NetworkService` includes an `NetworkError` enum with localized descriptions, which is good practice.

---
## Specific Code Observations & Recommendations

-   **String Literals for Keys/Tags**:
    -   For things like `OnboardingTooltipAnchorData` tags, `OnboardingSectionKey.rawValue`, Firestore field names, and Notification names, consider using string-based enums or static constants to avoid typos and improve maintainability.
    -   Example: `OnboardingSectionKey` is an enum, which is good. Notification names are also well-defined (`Notification.Name.handleDeepLinkFromNotification`).
-   **EnvironmentObject Usage**:
    -   `EnvironmentObject` is used extensively for passing ViewModels (e.g., `AuthenticationViewModel`, `UserProfileViewModel`, `CookbookViewModel`). This is appropriate for shared state. Ensure objects are injected correctly at the root of the relevant view hierarchy (e.g., in `SauceyApp` or `ContentView`).
-   **Deep Linking Robustness**:
    -   `DeepLinkManager` parses URL components. Ensure this parsing is robust and handles potential malformed URLs gracefully.
    -   `ContentView`'s `handleDeepLink` method shows conditional logic based on authentication state, which is important.
-   **Image Handling**:
    -   `ReusableRecipeImageView` uses Kingfisher, which is good for network image loading and caching.
    -   `ProfileImageView` handles both local `Data` and remote `URL` strings.
-   **Service Layer Consistency**:
    -   The service layer uses protocols (`XServiceProtocol`) and implementations (`XService`), which is a strong pattern for testability and modularity.
    -   Ensure all service interactions (especially writes) handle errors appropriately and propagate them to the ViewModels.
-   **Simplify Complex View Logic**:
    -   `CreatorProfileView` has a lot of `@ViewBuilder` functions for its sections. This is a good way to break down the `body`. Ensure the conditions within these builders remain manageable.
    -   `GroceryCartView` also has complex state management with `selectedTab` and different views for items. The use of helper views like `SectionedGroceryItemsView` and `RecipeOrManualItemsView` is good.
-   **Review `@MainActor` Usage**:
    -   While many ViewModels are marked `@MainActor`, ensure that any helper classes or services that directly manipulate `@Published` properties or perform UI updates are also main-thread-safe or explicitly dispatch to the main actor.
    -   `Utilities.getTopViewController` is `@MainActor`, which is correct as it interacts with `UIApplication.shared`.
    -   `SpeechRecognizer` is also `@MainActor`.

---
## Simplification and Avoiding Overly Nested Functions

-   **Guard Clauses**: Use `guard let ... else { return }` for early exits to reduce nesting when checking optionals or conditions. This is used in many places.
-   **Extract to Private Methods**: If a part of a function (especially in Views or ViewModels) becomes complex or involves multiple steps, extract it into a clearly named private method.
    -   `ContentView.handleDeepLink` and `handleTourNavigationRequest` are good examples.
    -   `CookbookViewModel.saveEditedRecipe` has significant logic; while well-structured, if it were to grow much more, parts could be extracted.
-   **Smaller, Reusable Views**: SwiftUI encourages breaking down views. Continue this practice.
    -   `RecipeSummaryCard`, `ChapterRow`, `FilterButtonView` are good examples of reusable UI components.
-   **ViewModel Responsibilities**: Ensure ViewModels handle presentation logic and don't become overly bloated. If a ViewModel manages too many distinct states or operations, consider if it can be split or if some logic can be moved to a service.
    -   `CookbookViewModel` is quite large and handles chapters, recipe management, search, and navigation triggers. This is an area to monitor as the app grows.
    -   `RecipeChatViewModel` also manages conversation state, message sending, and interaction with other ViewModels.
-   **Limit Closure Nesting**: If you have closures nested several levels deep (e.g., in Combine chains or completion handlers), try to flatten them using `async/await` where possible or by extracting parts into separate functions. The project already makes good use of `async/await`, which helps mitigate this.

By adhering to these rules and principles, the "Saucey" project can maintain a clean, scalable, and maintainable codebase.