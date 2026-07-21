#include "StringArtist.h"

#include <iostream>
#include <unordered_set>
#include "BresenhamLineIterator.h"

// (no fixed CANVAS_LINE_OPACITY anymore — see windString(): the canvas is now
//  drawn with the same auto-tuned opacity as the draft, so a single thread no
//  longer instantly saturates a pixel to pure black)

StringArtist::StringArtist(const Image& image, unsigned int numPins, float draftOpacity, float threshold, unsigned int skipped_neighbors, unsigned int scaleFactor, unsigned int minSteps, unsigned int maxSteps) :
    m_imagePtr(&image),
    m_numPins(numPins),
    m_draftOpacity(draftOpacity),
    m_threshold(threshold),
    m_skippedNeighbors(skipped_neighbors),
    m_scaleFactor(scaleFactor),
    m_iteration(0),
    m_minSteps(minSteps),
    m_maxSteps(maxSteps)
{
    m_canvas = StringArtImage(m_imagePtr->size() * m_scaleFactor, m_numPins);
    m_draft = StringArtImage(m_imagePtr->size(), m_numPins);
    m_adjacency.resize(m_numPins, std::vector<bool>(m_numPins, false));
}

void StringArtist::windString()
{
    size_t currentPinId = 0;
    std::cout << "Запуск адаптивного плетіння ниток..." << std::endl;
    
    m_iteration = 0;
    m_totalDistancePixels = 0.0;
    m_pinSequence.clear();
    m_pinSequence.push_back(currentPinId);

    // Авто-прозорість: вираховуємо середню яскравість фотографії
    double totalBrightness = 0;
    size_t imgSize = m_imagePtr->size();
    for(size_t y = 0; y < imgSize; ++y) {
        for(size_t x = 0; x < imgSize; ++x) {
            totalBrightness += m_imagePtr->getPixelValue(Point2D(x, y));
        }
    }
    double avgBrightness = totalBrightness / (imgSize * imgSize);
    
    // Якщо фото світле — робимо нитку жирнішою, якщо темне — тоншою
    m_draftOpacity = 0.16f * (avgBrightness / 128.0f);
    std::cout << "[Авто-Параметр] Розрахована прозорість нитки: " << m_draftOpacity << std::endl;

    while (m_iteration < m_maxSteps)
    {
        size_t nextPinId;
        float bestScore;
        bool found = findNextPin(currentPinId, nextPinId, bestScore);

        if (!found)
        {
            std::cerr << "[Попередження] Більше немає доступних пар гвіздків "
                       "(skipped_neighbors чи вже використані пари вичерпали "
                       "варіанти) — зупиняюсь на " << m_iteration << " лініях."
                      << std::endl;
            break;
        }

        // Нижче minSteps ми ЗОБОВ'ЯЗАНІ продовжувати — навіть якщо найкраща
        // лінія вже не дуже допомагає — бо бізнесу потрібна консистентна
        // кількість ниток. Після minSteps діє звичайна зупинка за threshold.
        bool belowWindow = m_iteration < m_minSteps;
        if (!belowWindow && bestScore > -m_threshold)
        {
            break;
        }

        m_iteration++;

        // Метраж
        Point2D p1 = m_draft.getPin(currentPinId);
        Point2D p2 = m_draft.getPin(nextPinId);
        double dx = p2[0] - p1[0];
        double dy = p2[1] - p1[1];
        m_totalDistancePixels += std::sqrt(dx * dx + dy * dy);

        // Малюємо ОДНОЧАСНО на чернетку і на фінальне полотно, з ОДНАКОВОЮ
        // прозорістю — інакше фінальне полотно перестає відображати те, що
        // реально планувалось під час підрахунку скору. Чернетка завжди 1px
        // (вона в тій самій роздільній здатності, що й вихідне фото — так і
        // рахувався score). Товщина нитки на ФІНАЛЬНОМУ полотні масштабується
        // разом з m_scaleFactor — інакше на високій роздільності лінія
        // виглядає пропорційно тоншою і картинка виходить блідою. Значення
        // підібране емпірично: при scaleFactor=4 радіус=1 (штрих ~3px) дає ту
        // саму візуальну щільність (mean/частка чорного), що й немасштабоване
        // полотно scaleFactor=1. Якщо scale_factor продукту колись зміниться —
        // варто перевірити mean/black_frac заново на реальному фото.
        unsigned int canvasBrush = m_scaleFactor >= 4 ? m_scaleFactor / 4 : 0;
        drawLine(m_draft, currentPinId, nextPinId, m_draftOpacity, 0);
        drawLine(m_canvas, currentPinId, nextPinId, m_draftOpacity, canvasBrush);
        
        m_adjacency[currentPinId][nextPinId] = true;
        m_adjacency[nextPinId][currentPinId] = true;
        currentPinId = nextPinId;
        m_pinSequence.push_back(currentPinId);
    }

    if (m_iteration == 0)
    {
        std::cerr << "\n[Попередження] Жодної лінії не намальовано — threshold="
                  << m_threshold << " занадто високий: жодна лінія не дає "
                  << "в середньому такого сильного затемнення на піксель. "
                  << "Спробуй значення приблизно 0.5-20 (типово; для цього "
                  << "фото навіть 100 дає лише ~850 ліній, а 150+ дає 0)."
                  << std::endl;
    }

    // Рахуємо фізичний метраж для коробки (діаметр рами 50 см)
    double boardSizeMeters = 0.5; 
    double totalMeters = m_totalDistancePixels * (boardSizeMeters / m_imagePtr->size());

    std::cout << "\n==========================================" << std::endl;
    std::cout << "ГЕНЕРАЦІЮ УСПІШНО ЗАВЕРШЕНО!" << std::endl;
    std::cout << "Всього ліній проплетено: " << m_iteration << std::endl;
    std::cout << "Чистий метраж нитки: " << totalMeters << " м." << std::endl;
    std::cout << "Для коробки (+20% запасу): " << totalMeters * 1.20 << " м." << std::endl;
    std::cout << "==========================================" << std::endl;

    // Машинно-читабельний рядок для бекенду — щоб Node.js не парсив
    // українську текстову шапку регулярками, а брав готовий JSON.
    // "pins" — повна послідовність (включно зі стартовим піном 0) — саме
    // те, що потрібно застосунку складання для покрокової інструкції.
    std::cout << "##RESULT##{"
              << "\"lines\":" << m_iteration << ","
              << "\"meters\":" << totalMeters << ","
              << "\"metersWithMargin\":" << (totalMeters * 1.20) << ","
              << "\"pins\":[";
    for (size_t i = 0; i < m_pinSequence.size(); ++i)
    {
        if (i > 0) std::cout << ",";
        std::cout << m_pinSequence[i];
    }
    std::cout << "]}" << std::endl;
}

bool StringArtist::findNextPin(const size_t currentPinId, size_t& bestPinId, float& bestScore) const
{
    bestScore = 999999.f;
    bestPinId = currentPinId;

    for (size_t nextPinId = 0; nextPinId < m_numPins; ++nextPinId)
    {
        int rawDiff = std::abs(static_cast<int>(currentPinId) - static_cast<int>(nextPinId));
        int circularDiff = std::min(rawDiff, static_cast<int>(m_numPins) - rawDiff);
        if (circularDiff <= static_cast<int>(m_skippedNeighbors) ||
            m_adjacency[currentPinId][nextPinId])
        {
            continue;
        }

        unsigned int pixelChanged;
        float score = lineScore(currentPinId, nextPinId, pixelChanged);

        if (score < bestScore)
        {
            bestScore = score;
            bestPinId = nextPinId;
        }
    }
    return bestPinId != currentPinId;
}

float StringArtist::lineScore(const size_t currentPinId, const size_t nextPinId, unsigned int& pixelChanged) const
{
    pixelChanged = 0;
    float score = 0.f;
    Point2D currentPin = m_draft.getPin(currentPinId);
    Point2D nextPin = m_draft.getPin(nextPinId);
    Point2D diff = nextPin - currentPin;
    int distance = std::max(std::abs(diff[0]), std::abs(diff[1]));

    if (distance == 0) return 999999.f;

    for (const Point2D& pixel : BresenhamLineIterator(currentPin, nextPin))
    {
        int target = m_imagePtr->getPixelValue(pixel); // Яка темрява потрібна (0 = чорний)
        int current = m_draft.getPixelValue(pixel);   // Яка темрява є зараз на холсті

        // current > target  -> ще занадто світло тут, треба темнішати (внесок від'ємний, це "добре")
        // current < target  -> вже перетемнили, ця лінія тут шкодить (внесок додатний, "погано")
        // current == target -> нейтрально (внесок 0)
        score += (target - current);

        ++pixelChanged;
    }
    return score / distance;
}

void StringArtist::drawLine(StringArtImage& image, const size_t currentPinId, const size_t nextPinId, const float opacity, const unsigned int brushRadius)
{
    int darken = static_cast<int>(255 * opacity);
    int size = static_cast<int>(image.size());

    // Дедуплікація: якщо пензлик товщий за 1px, сусідні "штампи" вздовж лінії
    // перекриваються — без цього один і той самий піксель темнішав би по
    // кілька разів ЗА ОДИН прохід нитки, і зображення миттєво пересичувалось.
    // Кожен піксель повинен темнішати рівно один раз за один виклик drawLine.
    std::unordered_set<long long> visited;

    for (const Point2D& pixel : BresenhamLineIterator(image.getPin(currentPinId), image.getPin(nextPinId)))
    {
        for (int dy = -static_cast<int>(brushRadius); dy <= static_cast<int>(brushRadius); ++dy)
        {
            for (int dx = -static_cast<int>(brushRadius); dx <= static_cast<int>(brushRadius); ++dx)
            {
                int px = pixel[0] + dx;
                int py = pixel[1] + dy;
                if (px < 0 || py < 0 || px >= size || py >= size)
                {
                    continue; // за межами полотна — пропускаємо
                }

                long long key = static_cast<long long>(py) * size + px;
                if (!visited.insert(key).second)
                {
                    continue; // цей піксель вже стемнів у цьому проході нитки
                }

                Point2D p(px, py);
                int currentVal = image.getPixelValue(p);

                // Стандартне комерційне накладання: нитка робить піксель темнішим
                int newValue = currentVal - darken;
                if (newValue < 0) newValue = 0; // Захист від виходу за межі чорного

                image.setPixelValue(p, static_cast<unsigned char>(newValue));
            }
        }
    }
}

void StringArtist::saveImage(std::FILE* outputFile)
{
    // ЗАМІСТЬ m_draft МИ ПЕРЕДАЄМО m_canvas (ФІНАЛЬНЕ ВЕЛИКЕ ПОЛОТНО)
    // Саме тут малюються чіткі чорні лінії високої роздільної здатності!
    std::string header = "P5\n" + std::to_string(m_canvas.size()) + " " + std::to_string(m_canvas.size()) + "\n255\n";
    std::fwrite(header.c_str(), 1, header.size(), outputFile);
    std::fwrite(m_canvas.getFirstPixelPointer(), 1, m_canvas.size() * m_canvas.size(), outputFile);
    std::fclose(outputFile);
    
    std::cout << "Saved successfully to pgm file: (high-res size: " << m_canvas.size() << ")" << std::endl;
}