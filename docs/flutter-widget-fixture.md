# Synthetic Flutter widget fixture

This documentation-only toy supplies a small Flutter package for the
[verification-image recipe](verification-images.md#flutter). It is not an
installed application, generated platform scaffold, or checked native runtime
fixture. These snippets and that image recipe have not been exercised end to
end; they are not evidence that Flutter checks pass in Graph Engineering.
They add no dependency to this repository and use no other project's data.

## Package contents

In a separate disposable toy directory, an operator can create these three
files. Only the Flutter SDK and its SDK-provided test library are declared;
their transitive package resolutions still need a real reviewed lockfile.

### `pubspec.yaml`

```yaml
name: toy_widget_fixture
description: A synthetic widget used to illustrate offline verification.
publish_to: none
version: 0.0.1
environment:
  sdk: ">=3.0.0 <4.0.0"
dependencies:
  flutter:
    sdk: flutter
dev_dependencies:
  flutter_test:
    sdk: flutter
```

### `lib/toy_label.dart`

```dart
import 'package:flutter/widgets.dart';

class ToyLabel extends StatelessWidget {
  const ToyLabel({super.key, this.label = 'Toy widget'});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(label, textDirection: TextDirection.ltr);
  }
}
```

### `test/toy_label_test.dart`

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:toy_widget_fixture/toy_label.dart';

void main() {
  testWidgets('renders and updates the toy label', (tester) async {
    await tester.pumpWidget(const ToyLabel());
    expect(find.text('Toy widget'), findsOneWidget);

    await tester.pumpWidget(const ToyLabel(label: 'Updated toy widget'));
    expect(find.text('Toy widget'), findsNothing);
    expect(find.text('Updated toy widget'), findsOneWidget);
  });
}
```

## Before using the offline recipe

An operator first selects and verifies a Flutter SDK archive using its
published checksum, as described in the linked recipe. In the disposable toy
directory, a deliberate `flutter pub get` with that SDK produces the actual
`pubspec.lock`; this initial dependency resolution can require network access.
Review and retain that lockfile with the toy sources before attempting the
recipe's `--enforce-lockfile` build. No lockfile or resolved hashes are invented
here, and no SDK installation or package download is performed by this
documentation change.

Warm the verification image with the same reviewed SDK, sources and lockfile.
The later Graph check operates offline on a copy and retains
`flutter pub get --offline --enforce-lockfile && flutter test --no-pub`.
Keep the SDK writable by the check's user, the cache's `active_roots` directory
writable, and the remaining recipe controls intact. Record actual image,
SDK, lockfile and test evidence before describing this toy as verified.

This example tests only a widget in the Flutter test harness. It does not
establish Android, iOS, desktop or web build support, nor Flutter dependency
resolution by Graph's source-only Dart analyzer. Flutter native CI remains
deferred under the [Dart/Flutter design](dart-and-generator-steps-design.md#decisions).
